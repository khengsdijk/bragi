# 06 — AI Intent Planner

Status: Draft v0.3 · Code: `services/api/src/planner/` · Schemas: `packages/schemas/planner/`

The planner turns **what the user wants** ("make this more aggressive", "add strings under the chorus", "make the outro longer and dreamier") into an **EditPlan**: concrete ops ([02 §4](02-song-model.md)) plus generation steps ([09](09-generation.md)), offered as 1–3 variants. It is the bridge between plain language and the deterministic model.

## 1. Where requests come from

| Source | Example | Goes through the LLM? |
|---|---|---|
| Lasso + prompt | Region + "half-time, more lo-fi" | Yes |
| Song chat panel | "Can the bridge be calmer?" | Yes |
| Paint brush | "Add shimmer" brush stroke on region | **No**: a fixed brush → op/generation template |
| Vibe slider / macro | Brightness +0.4 on the drums | **No**: direct `fx.update` |
| Drag-to-extend | End handle dragged +16 bars | **No**: direct `generate.extend` job |
| Energy skyline drag | Bridge target lowered | **No**: deterministic skyline compiler (§6), LLM optional for flavour |
| Instrument swap menu | Piano → Rhodes | **No**: `transform.timbre` job template |
| "Explain this" | Click on bar 33 | Yes (answer only, no ops) |

**Rule:** direct-manipulation gestures never wait on an LLM. The LLM is only in the loop for free text.

## 2. Inputs to the planner

```ts
interface PlanRequest {
  projectId: ProjectId; commitId: CommitId;
  prompt: string;                         // user's words (untrusted)
  region?: Region;                        // from lasso / selection
  uiContext: { view: "song" | "moment"; selectedTrackIds: TrackId[]; selectedSectionIds: SectionId[] };
  variantCount?: 1 | 2 | 3;               // default 3
  preferences?: { keepVocals?: boolean; maxCredits?: number };
}
```

The API loads the commit snapshot and calls `bragi-model::summarize_for_llm(doc, &focus)` (using the same WASM build, `packages/model-wasm`, running in Node). The analyses travel inside the document as `analyses[].summary` and `analyses[].effects`, so no separate bundle is passed (`docs/wp/2.6.md`). It produces a **compact LLM context** of about 2–6k tokens:

> **v1 note (WP-2.6):** the server holds no projects (history is local-first), so `POST /v1/plans`
> carries the `Project` document in the request (`PlanRequest.doc`) and the API never stores it.
> Analyses travel inside the document, which is everything `summarize_for_llm` needs. The
> `projectId`/`commitId` pair above stays the shape for a future hosted sync; the current schema
> takes the document instead ([`docs/wp/2.6.md`](../docs/wp/2.6.md), Deviation 1).

```
SONG: "Midnight Drive" · 118 BPM · F# minor · 4/4 · 4:00 · genres: synthwave · moods: nostalgic, driving
TRACKS: trk_v Vocals | trk_d Drums | trk_b Bass | trk_o Synths(other) | trk_p Piano | trk_r residual(hidden)
SECTIONS (idx, id, kind, bars, startBar, energy, chords, active stems, locked):
 0 sec_a intro     8  1  0.21 i-VI      piano,synths
 1 sec_b verse     16 9  0.48 i-VI-III-VII vocals,drums,bass,synths
 2 sec_c chorus    8  25 0.83 VI-VII-i  all
 ...
FOCUS REGION: bars 41–56 (sec_e "Verse 2"), tracks: Drums
  drums fx: none · drum pattern density: 0.71 · descriptors: punchy, gated
CURRENT FX/MACROS: Synths: space +0.3
CAPABILITIES: <catalogue IDs only: ops, fx types+param ranges, macros, generation capabilities with cost>
```
The capability catalogue is generated from `fx_catalog.json`, `macros.json`, the op schemas and the generation capability registry ([09 §2](09-generation.md)). It is never hand-written in prompts.

## 3. Output: `EditPlan`

```ts
interface EditPlan {
  planId: PlanId;
  interpretation: string;          // plain language: "I'll halve the drum feel in Verse 2 and add tape-style lo-fi."
  clarification?: { question: string; options: string[] };   // only when truly ambiguous; then variants may be empty
  variants: PlanVariant[];         // 1..3
  estimatedCredits: number;
  estimatedSeconds: number;
}

interface PlanVariant {
  label: string;                   // "Subtle", "Dusty tape", "Full half-time rework"
  description: string;
  steps: PlanStep[];
}

type PlanStep =
  | { kind: "ops"; ops: Op[] }                                   // applied directly (instant)
  | { kind: "generate"; id: string; capability: string; params: object; context: ContextSpec }   // a job
  | { kind: "apply_generated"; from: string; placement: Placement }   // turns job output into clip ops
  | { kind: "smooth"; region: Region; tools: ("crossfade" | "loudness_match" | "spectral_match" | "beat_align")[] };

interface Placement { region: Region; trackId?: TrackId; newTrack?: { name: string; role: StemRole }; mode: "replace" | "layer" | "insert" }
interface ContextSpec { before?: TickRange; after?: TickRange; tracks: TrackId[] | "all"; conditioningStems?: TrackId[] }
```

The plan is a **small program**. Ops-only variants are instant. Variants with `generate` steps become jobs.

## 4. LLM call

- Calls an LLM through **OpenRouter** (OpenAI-compatible chat completions, key `OPENROUTER_API_KEY`, [ADR-0012](decisions/ADR-0012-describe-llm-client.md)) using OpenAI-format **tool calling** with a single tool `propose_edit_plan` whose input schema is the `EditPlan` JSON Schema (minus `planId` and the estimates).
- **Model tiering** (configured in `config/planner.toml` as OpenRouter slugs, `vendor/model`; never hard-coded, and the owner may change them freely to trade quality against cost):
  - `fast` tier for short prompts that map to mix/fx edits (classified by a cheap heuristic: no generation verbs, region ≤ 1 track).
  - `smart` tier for everything else.
- Tool calling must be supported by the chosen model (OpenRouter's model list shows this); if a model returns the plan as plain JSON instead of a tool call, the same schema validation and one repair round apply (§5).
- **Prompt caching** is provider-dependent through OpenRouter. The prompt is laid out so the stable prefix (system prompt, capability catalogue) comes first and can be cached where the provider supports it, but nothing may depend on caching for correctness or for the latency and cost budgets.
- System prompt (stored in `services/api/src/planner/prompts/system.md`, versioned) instructs the model to:
  1. Prefer the **cheapest sufficient** lever: fx/macro → arrangement ops → generation.
  2. Make variants **meaningfully different** (different interpretations or intensities), not three near-identical ones.
  3. Never touch `locked` sections or tracks outside the region unless the prompt clearly asks.
  4. Ask a clarification only when the interpretations would lead to very different, costly results.
  5. Translate artist or style names into **sonic descriptors** ([10 §7](10-fusion.md)), never pass artist names to generation.
  6. Write `interpretation` and labels in plain, jargon-free language.
- User text goes inside a delimited `<user_request>` block and is treated as data. The planner has no tools besides `propose_edit_plan`.

## 5. Validation and execution

```
LLM → EditPlan (raw)
  → JSON Schema validation
  → for each variant: dry-run all "ops" steps with bragi-model::apply on the snapshot (generated assets stubbed)
  → check credits ≤ user remaining and ≤ preferences.maxCredits
  → on failure: one repair round (send validation errors back to the LLM), then fail gracefully with a message
  → return plan to client
```

**Execution** (after the user clicks "Try it", or immediately if the user has "auto-run" on):
1. The client calls `POST /plans/{id}/execute`. The API enqueues `generate` steps as jobs (variants run in parallel) and returns job IDs.
2. The client builds each variant's **candidate commit** progressively. Ops steps are applied immediately. `apply_generated` steps are applied when their job's `preview` output arrives (low quality) and **re-applied with the HQ asset** on accept ([09 §5](09-generation.md)).
3. `smooth` steps compile into ops (fades, `match_eq` fx, gain automation, warp anchors) using the engine's seam toolkit ([03 §8.2](03-audio-engine.md)). They run client-side in the engine's offline renderer.
4. The candidates appear in the Audition bar ([07 §6](07-song-canvas.md)).

## 6. Energy skyline compiler (deterministic)

When the user drags the energy skyline, each affected section gets an `energyTarget`. The compiler computes `Δ = target − current` per section and picks levers from a ladder, stopping when the predicted energy reaches the target:

| |Δ| | Levers (in order) | Instant? |
|---|---|---|
| ≤ 0.08 | Section gain automation (±1.5 dB) + `intensity` macro ±0.2 on the master | Yes |
| ≤ 0.20 | + `distance`/`brightness` macros on non-vocal tracks, `punch` on drums, filter sweeps across the section | Yes |
| ≤ 0.35 | + **density changes**: mute or unmute stems guided by `stem_activity` (drop the drums to lower energy, bring back synths from the chorus to raise it). Uses `region.adopt` from a higher-energy section of the same `repeatGroup` when available. | Yes |
| > 0.35 | + **generation**: `generate.variation` on the section with an energy conditioning parameter ("higher energy, denser drums, add risers") or `generate.stem` for an extra layer | No (job) |

- Predicted energy uses the same formula as analysis ([04 §5.5](04-analysis-pipeline.md)), estimated from the lever effect table in `config/energy_levers.toml` (e.g. muting the drums ≈ −0.25 when the drums hold 30% of the energy share).
- Output is a normal `EditPlan` with up to 2 variants ("Mix only" / "Re-arranged"), so the audition flow is the same as everywhere else.
- Unit-tested against fixtures: given analysis + targets, the produced ops match snapshots.

## 7. Guardrails

- **Schema-only output:** anything the LLM produces is data that passes schema + dry-run validation. There is no free-form code execution.
- **Region discipline:** ops touching ticks or tracks outside the requested region are rejected unless the variant declares `scope: "song"` and the prompt contained a song-wide intent (checked by a simple classifier and shown to the user: "This will change the whole song").
- **Cost discipline:** a plan above 50 credits requires explicit confirmation.
- **Content policy:** generation steps are checked against [10 §7](10-fusion.md) (no artist names in prompts, no voice cloning).
- **Prompt injection:** analysis-derived text (lyrics, titles, filenames) is escaped and placed in data blocks. Instructions inside lyrics or filenames must be ignored, and this is covered by a test case.

## 8. "Explain this"

`POST /plans` with `prompt` beginning with an explain intent (or the dedicated `explain: true` flag) returns:
```ts
interface Explanation { text: string; highlights: { region: Region; label: string }[]; learnMore?: string }
```
Explanations must ground every claim in analysis features. For example: "At bar 24 the drums stop for one bar (drum stem silent 24.1–25.0), creating a gap before the chorus." The UI draws the `highlights` on the canvas.

## 9. Evaluation

`services/api/test/planner-bench/` contains about 100 cases: `{ fixtureProject, region?, prompt, expectations }`. Expectations are structural, for example "uses only fx/macro ops", "touches only trk_drums in bars 41–56", "≥ 2 distinct lever types across variants", or "asks clarification".

| Metric | Target |
|---|---|
| Valid plan rate (after the repair round) | ≥ 98% |
| Expectation pass rate | ≥ 85% |
| Plan latency P50 / P95 (ops-only) | < 2.5 s / < 6 s |
| Over-reach (touches outside region without song-wide intent) | 0 |

The bench runs on demand (`pnpm bench:planner`) and in CI weekly (it costs API credits).

## 10. Worked example

Prompt: **"make the drums in verse 2 half-time and more lo-fi"**, region = Verse 2, Drums.

```json
{
  "interpretation": "I'll make the drums in Verse 2 feel half as fast and give them a dusty, tape-like sound.",
  "variants": [
    { "label": "Lo-fi only", "description": "Same groove, dusty tape sound.",
      "steps": [ { "kind": "ops", "ops": [
        { "type": "fx.add", "scope": { "clip": "clp_d5" }, "fx": { "id": "fx_n1", "type": "lofi", "params": { "bits": 10, "rateHz": 16000, "wow": 0.3, "noise": 0.15, "mix": 0.8 }, "bypass": false } },
        { "type": "fx.add", "scope": { "clip": "clp_d5" }, "fx": { "id": "fx_n2", "type": "filter", "params": { "mode": 0, "cutoffHz": 6500, "resonance": 0.1 }, "bypass": false } } ] } ] },
    { "label": "Half-time feel", "description": "New half-time drum part generated to match the song, with lo-fi colour.",
      "steps": [
        { "kind": "generate", "id": "g1", "capability": "generate.stem",
          "params": { "role": "drums", "prompt": "half-time drum groove, lo-fi, dusty, tape saturation", "bars": 16, "seed": 11 },
          "context": { "before": { "startTick": 115200, "endTick": 153600 }, "tracks": "all", "conditioningStems": ["trk_b", "trk_o"] } },
        { "kind": "apply_generated", "from": "g1", "placement": { "region": { "startTick": 153600, "endTick": 215040, "tracks": ["trk_d"] }, "trackId": "trk_d", "mode": "replace" } },
        { "kind": "smooth", "region": { "startTick": 153600, "endTick": 215040, "tracks": ["trk_d"] }, "tools": ["crossfade", "loudness_match", "beat_align"] } ] },
    { "label": "Stripped half-time", "description": "Keep only kick and snare on 3 for a sparse half-time feel (no generation).",
      "steps": [ { "kind": "ops", "ops": [ { "type": "fx.add", "scope": { "track": "trk_d" }, "fx": { "id": "fx_n3", "type": "transient", "params": { "attack": 0.4, "sustain": -0.5 }, "bypass": false } } ] } ] }
  ]
}
```
Note: variant 3 is limited without the deep-profile `drum_split`. When kick/snare sub-stems exist, the planner can mute hats and re-pattern via `region.adopt` of single hits. The capability catalogue tells the planner what is available for this song.
