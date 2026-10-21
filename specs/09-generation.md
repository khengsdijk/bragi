# 09 — AI Generation

Status: Draft v0.5 · Code: `services/workers/generate/` · Schemas: `packages/schemas/jobs/capabilities/`

Generation in Bragi is **always in service of editing**. Every generated piece of audio lands in the song model as clips with provenance, gets analysed and separated like any other source, and can be edited, auditioned and undone.

## 1. Principles

1. **Context in, context-matching audio out.** Every request carries the song's musical facts (BPM, key, chords, time signature, section kind, energy, descriptors) and rendered context audio.
2. **Musical conformance is enforced, not hoped for.** Outputs are beat-aligned, tempo-conformed, key-checked and seam-smoothed *after* generation, and rejected if they fail the gates (§6).
3. **Generated audio is a normal source.** It becomes a `Source { kind: "generated" }`, gets `standard` analysis (stems, structure…), and appears as normal ribbons.
4. **Preview first, quality later** (§5).
5. **Model-agnostic.** Each capability goes through a `GenerationBackend` adapter. Models will change, but the capability contracts stay.

## 2. Capability registry

Defined in `services/workers/generate/capabilities.yaml` and exported to the planner's catalogue ([06 §2](06-ai-planner.md)).

| Capability | Purpose | Key inputs | Output | Credits (initial) |
|---|---|---|---|---|
| `generate.extend` | Continue the song forward (or backward for intros) | context audio (last 30 s), bars, direction, prompt? | audio (bars + 2-bar overlap) | 2 per 30 s |
| `generate.inpaint` | Fill a gap | context before + after, gap bars, prompt? | audio (gap + overlaps) | 2 per 30 s |
| `generate.variation` | Regenerate a section with changes | section audio, strength (0..1), prompt, energy delta | audio (section length) | 2 per 30 s |
| `generate.transition` | Bridge two sections smoothly | end of A (8 bars), start of B (8 bars), length (1–4 bars) | audio | 1 |
| `generate.stem` | Add or replace one instrument part | conditioning stems, role, prompt, bars, chords | mono/stereo stem audio | 2 per 30 s |
| `generate.text2music` | New song or section from description | prompt, duration, BPM, key, blueprint?, lyrics? | full-mix audio | 10 per song |
| `generate.fx` | Risers, impacts, sweeps, ambience, shimmer | prompt, length, BPM (for synced risers) | audio | 1 |
| `transform.timbre` | Swap an instrument (piano → strings) | stem audio, target instrument | stem audio | 2 per 30 s |
| `transform.style` | Re-style a section/song, keeping melody and structure | audio, style descriptors, strength | audio | 3 per 30 s |
| `transform.stem_resynth` | Clean a separated stem of artifacts | stem audio, role | stem audio | 2 per 30 s |

Every capability's params are defined as JSON Schema in `packages/schemas/jobs/capabilities/<capability>.schema.json`.

The API charges the "Credits (initial)" column through `config/credits.toml` (05 §9): a "per 30 s" cost is charged per candidate on the requested new audio, rounded up per started 30 s; a flat cost is charged once per job. `generate.extend` at 30 s therefore costs 2 per preview candidate and 2 for the HQ re-render.

### 2.1 Common conditioning block (all capabilities)
```ts
interface MusicalContext {
  bpm: number; timeSignature: [number, number]; key: { tonic: string; mode: "major" | "minor" };
  chords?: { startBeat: number; symbol: string }[];       // for the target span, beats relative to span start
  sectionKind?: SectionKind; energy?: number;             // 0..1 target
  descriptors: string[];                                  // from tags + user prompt, NO artist names
  seed: number;
}
```
The rendered conditioning audio is **not** in the params: it is a content-addressed job
input (`inputs.assets.context`, and `inputs.assets.context_after` where a capability needs
two sides), so it streams and caches like every other input. The schemas live in
`packages/schemas/jobs/capabilities/` (`MusicalContext` is shared in `common.schema.json`).

## 3. Model candidates (to be confirmed in ADR-0004)

> The open music-generation landscape changes month to month. WP-4.0 runs a **bake-off** on the eval set before committing. Record the chosen models in `MODELS.md` ([04 §9](04-analysis-pipeline.md)).

| Capability | Candidate families | Notes |
|---|---|---|
| extend / inpaint / variation / text2music | **ACE-Step-class** open song models (full songs, lyrics, repaint/extend editing) · **MusicGen-class** (continuation, melody conditioning) · hosted music APIs | Hosted APIs: check ToS on audio-input conditioning. |
| fx | **Stable Audio Open-class** text-to-audio | Good for short SFX/ambience |
| stem | Stem-conditioned generation (accompaniment / single-instrument models) **or** full generation + separation fallback | The fallback: generate full music with strong context, separate, keep the target role |
| timbre | **Strategy A (v1):** transcribe the stem to MIDI ([04 §7](04-analysis-pipeline.md)), then render with a high-quality sampler/SoundFont with velocity/expression mapping. **Strategy B (later):** neural timbre transfer (DDSP/diffusion). | A is deterministic, fast and good for piano/strings/brass. B is a research spike. |
| style | Melody/chroma-conditioned generation, or audio-to-audio "repaint" with partial strength | Strength 0.3–0.7 maps to "keep more of the original" ↔ "more new style" |
| stem_resynth | Audio-to-audio at low strength (0.2–0.35) conditioned on the stem itself | Removes warble while keeping the performance |

### 3.1 `GenerationBackend` interface (Python)
```python
class GenerationBackend(Protocol):
    name: str; version: str
    capabilities: set[str]
    max_duration_sec: float
    supports_audio_context: bool; supports_lyrics: bool; supports_preview_tier: bool
    def generate(self, req: GenRequest, tier: Literal["preview", "hq"], n: int,
                 on_progress: Callable[[float], None]) -> list[GenOutput]: ...
```
The routing table (`config/generation_routes.yaml`) maps `(capability, tier)` → backend, so models can be swapped without code changes. `BRAGI_GENERATION_BACKEND=fake` forces one backend for every route; the tests and the live e2e use it to run without a model. Tier → step counts and the server address live in `config/generation_backends.toml`.

## 4. Capability behaviour

### 4.1 `generate.text2music` (new songs)
1. Input comes from the "Create" dialog, the Universe ([08 §7.2](08-universe.md)), or the planner. The user gives a prompt, optional duration (default 2:30), BPM, key, an optional **blueprint** (§4.5) and optional lyrics.
2. Generate N=2 candidates (preview tier). The user picks one → HQ render.
3. The accepted audio becomes a new project: `Source(kind: generated)` with `standard` analysis queued, so it becomes fully editable within about a minute.
4. Suggested title from `describe`.

### 4.2 `generate.extend`
1. The engine renders context: the last **30 s ending on a bar line** (full mix by default, or selected stems if the extension is per-track).
2. Request `bars + 2` bars (a 2-bar overlap for splicing).
3. Post-process (§6): beat-align → tempo-conform → key check → **splice-point search** inside the overlap, minimising `seam_score` ([03 §8.2](03-audio-engine.md)) → crossfade → loudness and spectral match.
4. Placement: a new section (kind guessed: `outro` when extending at the end and the user asked for an ending, otherwise the same kind as the last section) with clips on a `generated` track. **Then** separation runs on the new audio, and its stems are mapped onto the existing stem tracks, so the extended part has matching ribbons.
5. Backward extension (intro): context = the first 30 s, generated audio is placed before.

### 4.3 `generate.inpaint`

The context includes both sides (up to 15 s each). The backend uses native infill/repaint if it supports it. Otherwise it falls back to extend-forward from the left context, plus a seam search on both boundaries (more failures, so more candidates are needed).

Placement: the processed audio fills the **gap range** as one source whose placement carries `range` and `srcStartSamples` (02 §6.4). `fill_placement` emits one clip per section the gap crosses, on the `generated` track; `startOffsetSamples` (negative when the processed audio starts inside the left overlap) is skipped at the clip head and `endOffsetSamples` (positive when it runs into the right context) is trimmed, so the gap is covered exactly. A gap that spans a section boundary is supported: the clips share one continuous source window. When separation of the fill arrives, `analysis.apply` maps the stems into the gap range only and removes the mix-only clip. The request is `{ gapRange, candidate, startOffsetSamples, endOffsetSamples, crossfadeTicks, batchId, label, createdAt }` (camelCase JSON; `candidate` is the same block extend takes), exposed as `fillPlacement`.

### 4.4 `generate.transition`
Used for "✨ Smooth with AI" after section moves ([07 §4.1](07-song-canvas.md)). The output becomes a `Transition { kind: "generated", asset, lengthTicks }` on the section ([02 §3.5](02-song-model.md)), so the engine plays it as an overlay across the boundary with crossfades ([03 §5.5](03-audio-engine.md)). `transition_placement` commits it as one batch: `source.add` (provenance, placement-owned, **no lane clip**) and `section.set_transition` with the working asset and `lengthTicks`. The first section has no boundary before it and is rejected. The request is `{ sectionId, candidate, lengthTicks, batchId, label, createdAt }`, exposed as `transitionPlacement`.

### 4.5 Long-form mode and the song blueprint
For songs longer than one model call (up to **10 minutes**):
1. **Blueprint editor:** the user arranges blocks (kind, bars, energy 0..1, descriptors, optional lyrics per block) on a strip that looks like the Section blocks lane. Templates include "Pop song", "Club extended mix", "Ambient journey" and "Lo-fi loop set". The planner can draft a blueprint from text.
2. **Global style anchor:** first generate the **most important block** (the first chorus or drop) and let the user approve it. That block becomes the **style reference** for all other blocks.
3. Generate the remaining blocks **in order**, each conditioned on the previous block's audio (extend-style) plus the style anchor. **Repeated blocks** (same kind and same `repeatGroup` in the blueprint) start from the earlier instance and apply `generate.variation` at low strength (0.2–0.4), so choruses sound like the same chorus.
4. Stitch with the seam toolkit. Each block lights up in the blueprint as it completes, and the user can regenerate any single block.
5. The result is one project whose sections already match the blueprint (structure analysis is skipped for these, or only used to refine boundaries).

### 4.6 `transform.stem_resynth` ("✨ Clean up")
For stems with audible separation artifacts. Audio-to-audio at low strength conditioned on the stem and role. The candidate replaces the stem clips in the region. This is especially useful before soloing vocals or exporting stems.

### 4.7 `transform.timbre` (Strategy A detail)
1. Run `transcribe` for the stem if it's missing (deep stage on demand).
2. Quantise lightly (preserving the groove: ≤ 30% strength toward the grid).
3. Render with the target instrument preset (sampler with velocity layers, round-robin and release tails). Presets live in `services/workers/generate/instruments/`.
4. Match the original stem's loudness envelope (gain automation, smoothed) and place it on the same track (replace) or a new track (layer).

## 5. Latency tiers

| Tier | Purpose | Target (30 s of audio) | Quality |
|---|---|---|---|
| **preview** | Audition candidates quickly | First preview **≤ 15 s** after the request (when the GPU is warm) | Fewer diffusion steps / smaller model, 32–44.1 kHz, may be slightly noisy |
| **hq** | Accepted result | ≤ 60 s, in the background after accept | Full steps, 44.1–48 kHz stereo |

- Long jobs stream `partial` outputs ([05 §3](05-backend-and-jobs.md)). In long-form mode each block is a partial. A partial carries the worker's `outputs` verbatim, so an extend candidate's audio and its gate-result blob arrive together.
- An **HQ re-render** of an accepted candidate repeats the submit with `tier: "hq"`, `n: 1` and the candidate's `seed` (`params.seed`) as a `background` job, so the render starts from the same seed. Reproducibility is not bit-exact on MPS yet (see `docs/wp/2.7.md`, A1).
- Queue transparency: the UI shows "Waiting for a free generator… (~20 s)" from the `etaSec` field.
- Cold-start mitigation: the first interactive generation request of a session sends a cheap **warm-up ping** when the user opens the canvas, if a generation pool is scaled to zero. The ping is `POST /v1/generations/warmup` → `202 { status: "warming" | "warm" | "disabled" }`; it submits the internal `generate.warmup` job, which loads the model (ACE-Step loads through its `/v1/init`; the fake backend is a no-op). Pings while one is in flight, or within five minutes of a completion, do not queue work; `disabled` means no generation worker runs against this environment.

## 6. Seamlessness and quality gates (R1)

Every generated output passes through `postprocess.py`, in this order:

| Step | Method | Reject if |
|---|---|---|
| 1. Sanity | Detect silence (> 50% below −50 dBFS), clipping (> 0.1% samples at full scale), NaNs | Any |
| 2. Tempo conform | Beat-track the output, compare to the requested BPM, warp to the grid via anchors (rubato-free) | Tempo error > 4% before warping |
| 3. Key check | Key detection on the output | Off-key (not the same or a relative key) and not fixable by a ±1 semitone shift |
| 4. Beat align | Align the first downbeat to the grid (cross-correlation of onset envelopes with context) | Alignment confidence < 0.5 |
| 5. Splice search | Within the overlap window, find the splice point minimising `seam_score` at beat positions | Best `seam_score` > threshold (config) |
| 6. Loudness + spectral match | `loudness_match`, `spectral_match` against the context. Only a side that touches context is matched (an extend's far end keeps the model's own fade), and the gain never pushes the peak above −1 dBFS | — |
| 7. Final seam score | Logged for every candidate, used to sort candidates (best first) | — |

If fewer than the requested number of candidates pass, the worker regenerates (up to 2 extra rounds, new seeds). If none pass, it returns the best one with `qualityWarning: true`, and the UI shows "This one might not blend perfectly".

**Tracked metrics** (logged per job for eval dashboards): seam score distribution, tempo error, key match rate, acceptance rate per capability (the user's accept/discard), and regeneration rate.

## 7. Vocals, voices and lyrics

- Vocal generation is only allowed through models that support lyrics with **synthetic** voices.
- **No voice cloning or "sing like <artist>"**. Requests are refused with a friendly message ([10 §7](10-fusion.md)).
- A user may *keep* the existing vocal stem of their song and generate music around it.
- Lyrics are user-provided. The planner can *suggest* lyrics on request, clearly labelled as AI-written.

## 8. Provenance and labelling

- Every generated clip carries `Provenance { kind: "generation", model, modelVersion, prompt, jobId }`. A generated transition has no clip: its `Source` carries the provenance, and the section's `transitionIn.asset` is the working asset it refers to.
- Exports embed metadata: `Generated/edited with Bragi`, and for generated parts, `AI-generated content` in the ID3 `COMM`/Vorbis comment and BWF `bext` description.
- **Audio watermarking** of generated segments (e.g. an open-source neural watermark like AudioSeal) is planned for Phase 4 and evaluated for audibility first.

## 9. Acceptance checks

1. `generate.extend` on 5 fixture songs: ≥ 2 of 3 candidates pass all gates for at least 4 of 5 songs, and blind listening (owner) rates the seam as "unnoticeable" in ≥ 60% of accepted candidates.
2. Generated audio added to a project results in stem ribbons on matching tracks after separation (no orphan "generated" mix-only lane unless separation failed).
3. Long-form: a 6-minute blueprint with 3 choruses produces choruses whose pairwise section-embedding similarity is ≥ 0.85.
4. Time to first preview for a 30 s extend is ≤ 15 s P50 with a warm GPU.
5. A request containing an artist name in the prompt is rewritten into descriptors (planner) or refused (direct API), as covered by tests.
