# 02 — Song Model & Versioning

Status: Draft v0.4 · Owner crate: `crates/bragi-model` · Schemas: `packages/schemas/song/`

This is the **architectural heart** of Bragi. Every feature (canvas, AI edits, generation, fusion, export) reads and writes this model, and nothing else. If a feature can't be expressed as operations on this model, the model is extended here first (with an ADR).

## 1. Design goals

1. **Musical, not sample-based.** Arrangement positions are in musical time (bars/beats/ticks), so reordering sections, changing tempo and extending songs stay coherent.
2. **Section-centric.** Beginners think in "intro, verse, chorus", so the arrangement is an ordered list of section instances.
3. **Non-destructive.** Audio assets are immutable and content-addressed. Edits only change references, parameters and arrangement.
4. **Event-sourced.** All changes are typed **operations**, grouped in **batches**, recorded as **commits** in a DAG (the version tree).
5. **Deterministic rendering.** `render(document, assets, engineVersion)` always produces the same audio.
6. **Small documents.** Heavy analysis arrays live in separate content-addressed blobs and are referenced, not inlined.

## 2. Core concepts

```
Project
 ├─ sources[]          original inputs (uploads, generations, recordings) → Asset hashes
 ├─ analyses{}         per-source analysis results (refs to analysis blobs)
 ├─ tracks[]           instrument lanes (stems, generated parts, fx)
 ├─ arrangement
 │   ├─ timebase       PPQ, tempo map, time signatures
 │   ├─ sections[]     ORDERED section instances; each holds per-track clips
 │   └─ master         master fx chain + absolute-time master automation
 ├─ meta               title, tags, description, cover colour
 └─ (history lives outside the document: commits DAG)
```

### 2.1 Identifiers
- All entity IDs are **ULIDs** prefixed by type: `prj_…`, `src_…`, `trk_…`, `sec_…`, `clp_…`, `fx_…`, `op_…`, `bat_…`.
- The schema enforces the **prefix and the character set** (`^prj_[0-9A-Za-z]{1,64}$`), not the ULID layout: ULID is the *generation* rule, and `bragi-model` is where generation lives. That is why the hand-written `trk_mix`, `sec_01` and `clp_01` in §10 and §2.2 are valid, and why a schema test fixture never has to look like a real ULID.
- Job, plan and macro IDs use the same rule: `job_…` ([05 §3](05-backend-and-jobs.md)), `pln_…` (edit plans, [06](06-ai-planner.md)), `mac_…` (custom macros). The seven built-in v1 macros use their plain names from [03 §6.1](03-audio-engine.md) (`brightness`, `space`, …); the schema accepts either form. **User IDs are opaque strings**: Better Auth owns their format ([05 §8](05-backend-and-jobs.md)), so the schema only bounds the length.
- Assets are identified by **`sha256:<hex>`** of the file bytes: `sha256:` plus exactly 64 lowercase hex characters.
- Commits are identified by `cmt_` + the first 26 chars of the base32 SHA-256 of the canonical JSON of `(parents, batch, snapshotHash)`. The canonical JSON is `canonical_json`: keys sorted, no whitespace, and an integral `number` written without a fractional part (`0`, not `0.0`), so two logically equal documents hash the same regardless of the map iteration order of the generated types (Q15).

### 2.2 Time
| Domain | Unit | Notes |
|---|---|---|
| Musical | **ticks**, `i64`, **PPQ = 960** | All arrangement positions |
| Source audio | **samples** at the asset's working sample rate | Clip source ranges |
| Wall clock | seconds (`f64`) | Derived only, never stored |

- The project's internal sample rate is **48 000 Hz**. Ingest produces a 48 kHz, 24-bit FLAC working copy of every source ([04-analysis-pipeline.md §3.1](04-analysis-pipeline.md)).
- **Tempo map**: `[{ tick, bpm, curve: "step" | "linear" }]`, sorted, first entry at tick 0. `curve` is the ramp **from this point to the next**: `step` keeps this point's `bpm` until the next point (a jump), `linear` ramps linearly to the next point's `bpm`. The last point's tempo holds forever after it, and before tick 0 the first point's tempo is used.
- **Time signatures**: `[{ bar, numerator, denominator }]`.
- `bragi-model` provides `ticks_to_seconds`, `seconds_to_ticks`, `bar_beat_to_ticks` and `ticks_to_bar_beat`, which are the only allowed conversions. `bar` is 0-based; `beat` is 0-based and fractional within the bar (`2.5` is halfway through the bar's third beat), and a beat is one `denominator`-th note, so a 6/8 bar has six eighth-note beats.
- **Timestamps** (`ISODate`) are RFC 3339 in UTC with a `Z` suffix and optional fractional seconds: `^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$`. The schema uses a *pattern*, not `format: date-time`, so that no language parses a timestamp into a date type that would re-format it — timestamps therefore round-trip byte for byte.
- **Colours** (`HexColor`) are `#RRGGBB`: sRGB, six hex digits, no alpha.
- Every schema follows the same authoring conventions — `title` on every named type, one file per root type, a named `$def` for every object and multi-value enum, `additionalProperties: false` on every object, no `format`, no `\d` and no look-around in patterns — because they have to generate types and validators for three languages. The rules and the reasons are in [`packages/schemas/README.md`](../packages/schemas/README.md).

## 3. Entities (normative field lists)

TypeScript-style notation is used for readability. JSON Schema is the source of truth.

### 3.1 Project
```ts
interface Project {
  schemaVersion: 1;
  id: ProjectId;
  meta: {
    title: string; createdAt: ISODate; tags: string[]; description?: string; color?: HexColor;
    suggestedSections?: SectionSuggestion[];   // analysed sections the user has not accepted yet (02 §6.3)
  };
  sources: Source[];
  analyses: Record<SourceId, AnalysisRef>;
  tracks: Track[];
  arrangement: Arrangement;
}
```

### 3.2 Source & Asset
```ts
interface Source {
  id: SourceId;
  kind: "upload" | "generated" | "recorded" | "imported_stem";
  originalAsset: AssetHash;   // exact bytes the user provided (or generated)
  workingAsset: AssetHash;    // 48 kHz 24-bit FLAC produced by ingest
  durationSamples: number;    // at 48 kHz
  channels: 1 | 2;
  label: string;              // e.g. original filename or "Generated: dreamy outro"
  provenance?: Provenance;
}

interface AssetMeta {          // stored in DB/cache, not in the document
  hash: AssetHash; mime: string; bytes: number;
  sampleRate: number; channels: number; durationSamples: number;
  derivedFrom?: { assets: AssetHash[]; process: string; processVersion: string; params: object };
}

interface Provenance {
  kind: "user" | "separation" | "generation" | "transform" | "render";
  jobId?: JobId; model?: string; modelVersion?: string; prompt?: string; createdAt: ISODate;
}
```

### 3.3 AnalysisRef
The document stores only *refs* to analysis results, which are blobs whose shape is defined in [04-analysis-pipeline.md §6](04-analysis-pipeline.md).
```ts
interface AnalysisRef {
  profile: "quick" | "standard" | "deep";
  status: Record<AnalysisStage, "pending" | "running" | "done" | "failed">;
  blobs: Partial<Record<AnalysisStage, AssetHash>>;   // e.g. rhythm → sha256:…
  effects?: AnalysisEffect[];     // the projection of those blobs the arrangement is built from (02 §6, Q12)
  stems?: Partial<Record<StemRole, AssetHash>>;       // separated stems (working assets)
  summary?: { bpm: number; key: string; durationSec: number; genres: string[]; moods: string[] };
}
```
`blobs` is a *reference* to the full result, and `effects` is the small, typed projection of it that `analysis.apply` records. `bragi-model` never reads a blob (it has no I/O), so the facts the arrangement is derived from have to live in the document; `summary` needs `key`, which no effect carries, so it is written by the flow that owns the blobs.

### 3.4 Track
```ts
type StemRole = "vocals" | "drums" | "bass" | "guitar" | "piano" | "synth" | "strings" | "other"
              | "residual" | "full_mix" | "generated" | "fx" | "recorded";

interface Track {
  id: TrackId;
  name: string;               // "Drums", "Generated strings"
  role: StemRole;
  color: HexColor;            // from design palette per role
  gainDb: number;             // default 0
  pan: number;                // -1..1
  mute: boolean; solo: boolean;
  hidden: boolean;            // e.g. "full_mix" reference track after separation
  fx: FxInstance[];
  origin?: { sourceId: SourceId; stem?: StemRole };
}
```

**Residual track rule:** after separation, Bragi creates a `residual` track containing `mix − Σ stems` (computed by the worker). With all stem tracks unedited at 0 dB and the residual on, playback reconstructs the original mix almost exactly. The residual is hidden by default but always summed. When the user edits a stem heavily (swaps it, mutes it), the residual's corresponding band is attenuated per [03-audio-engine.md §8](03-audio-engine.md).

### 3.5 Arrangement & Sections
```ts
interface Arrangement {
  timebase: { ppq: 960; tempoMap: TempoPoint[]; timeSignatures: TimeSig[] };
  sections: SectionInstance[];        // ORDERED; absolute positions are derived
  master: { fx: FxInstance[]; automation: Automation[]; gainDb: number };
}

type SectionKind = "intro" | "verse" | "pre_chorus" | "chorus" | "post_chorus" | "bridge"
                 | "breakdown" | "build" | "drop" | "solo" | "interlude" | "outro" | "custom";

interface SectionInstance {
  id: SectionId;
  kind: SectionKind;
  label: string;                // "Chorus 2" (auto-numbered unless user-renamed)
  lengthTicks: number;          // must be > 0, normally a whole number of bars
  lanes: Record<TrackId, Lane>; // content per track, positions RELATIVE to section start
  transitionIn: Transition;     // how we enter this section from the previous one
  derivedFrom?: SectionId;      // set on duplicate, so the UI can show "copy of Chorus 1"
  energyTarget?: CurvePoint[];  // optional user-drawn target (0..1) from skyline editing
  locked?: boolean;             // AI ops may not modify locked sections
}

interface Lane { clips: Clip[]; automation: Automation[] }

interface CurvePoint {
  tick: number;                 // relative to the section start
  value: number;                // 0..1
}

interface Transition {
  kind: "cut" | "crossfade" | "generated";
  lengthTicks: number;          // 0 for cut
  asset?: AssetHash;            // for "generated": a bridging audio piece
}
```
The **absolute start tick** of section *i* is `Σ lengthTicks of sections[0..i)`. It is never stored.

### 3.6 Clip
```ts
interface Clip {
  id: ClipId;
  asset: AssetHash;               // working asset (stem, generated audio, etc.)
  srcStart: number; srcEnd: number;  // samples in the asset
  start: number;                  // ticks, relative to section start
  warp: Warp;                     // maps source samples → ticks
  gainDb: number; pitchSemitones: number;   // pitch-shift without tempo change
  fadeInTicks: number; fadeOutTicks: number; fadeCurve: "linear" | "equal_power" | "s_curve";
  reverse?: boolean;
  fx?: FxInstance[];              // clip-level fx (rare, mostly paint-mode results)
  provenance: Provenance;
}

type Warp =
  | { mode: "none" }                                       // play at source speed
  | { mode: "beatgrid"; anchors: { srcSample: number; tick: number }[] }   // follow tempo map
  | { mode: "stretch"; ratio: number };                    // fixed ratio
```
In `beatgrid` mode an anchor's `tick` is **section-relative**, the same frame as `start`: it is the tick at which that source sample plays. `none` and `stretch` need the asset's sample rate to convert seconds to ticks; `beatgrid` does not. Clip end tick is derived from the warp. Clips in a lane may overlap only if both have fades covering the overlap (validated).

### 3.7 Effects and automation
```ts
type FxType = "eq3" | "filter" | "compressor" | "saturation" | "reverb" | "delay"
            | "width" | "gain" | "transient" | "lofi" | "chorus" | "sidechain_duck"
            | "match_eq" | "limiter";   // match_eq: system-generated; limiter: master only

interface FxInstance {
  id: FxId;
  type: FxType;
  params: Record<string, number>;
  bypass: boolean;
  macroOwned?: MacroId;
  sidechainSource?: TrackId;   // only on sidechain_duck; 03 §6 sourceTrack
}

interface Automation {
  target: string;               // param path, e.g. "track:trk_…/gainDb", "fx:fx_…/cutoffHz"
  points: { tick: number; value: number; curve: "step" | "linear" | "exp" }[];
}
```
- The parameter ranges and defaults for each `FxType` are defined in `crates/bragi-dsp/fx_catalog.json`, which is shared with the UI and planner. See [03-audio-engine.md §6](03-audio-engine.md).
- `sidechainSource` is **routing**, not a numeric parameter: it names the key track for `sidechain_duck` (03 §6 `sourceTrack`) and is stored outside `params` so `FxParams` stays `Record<string, number>`. Only `sidechain_duck` may carry it.
- **Lane automation** is relative to its section. **Master automation** uses absolute arrangement ticks (used for global fades) and is re-anchored by `section.move` ops (see §5.3).
- `fx.add` and `automation.set`/`automation.clear` carry a **scope**, because an effect or curve can live in three different places:
  ```ts
  type FxScope    = { kind: "track"; trackId: TrackId } | { kind: "clip"; clipId: ClipId } | { kind: "master" };
  type AutomationScope = { kind: "lane"; sectionId: SectionId; trackId: TrackId } | { kind: "master" };
  ```
  `kind` is the discriminator; `fx.remove`, `fx.reorder` and `fx.update` take only an `fxId`, because an FX id is unique within the document.

### 3.8 Region (the universal selection)
A region is what the lasso, paint brush and AI prompt target.
```ts
interface Region {
  startTick: number; endTick: number;        // ABSOLUTE arrangement ticks
  tracks: TrackId[] | "all";
  freqRange?: [number, number];              // Hz, optional (paint & spectral edits)
}
```
`bragi-model::resolve_region(doc, region) -> ResolvedRegion` splits a region into per-section, per-lane slices. This is how every region-based op is applied.

## 4. Operations

Every change to a document is an `Op`. Ops are **concrete**. AI never emits "make it aggressive" as an op. The planner compiles intent *into* these ops ([06-ai-planner.md](06-ai-planner.md)).

### 4.1 Envelope
```ts
interface OpBatch {
  id: BatchId;
  author: { kind: "user" } | { kind: "ai"; planId: PlanId; model: string } | { kind: "system"; reason: string };
  intent?: string;          // user's words, e.g. "make the drums half-time"
  label: string;            // short human label for history: "Half-time drums (verse 2)"
  ops: Op[];
  createdAt: ISODate;
}
```
An `Op` is a **closed** object: `{ "op": "<name>", …payload }`, where `op` is the discriminator and the rest of the object is exactly the payload in the catalogue below. No op carries a field it does not define, so an unknown field is rejected rather than silently dropped (which is what keeps JSON → typed → JSON lossless in three languages). `ops` has at least one entry.

`JobId`, `PlanId` and `MacroId` appear in payloads; their formats are in §2.1.

A batch is atomic: it applies fully or not at all.

### 4.2 Op catalogue (v1)

| Op | Payload (summary) | Notes |
|---|---|---|
| `project.set_meta` | title?, tags?, description?, color?, suggestedSections? | An empty `suggestedSections` clears the analysis suggestions (02 §6.3) |
| `analysis.apply` | sourceId, stage, blob, effects[] | System op. Records an analysis stage and reconciles the document with it: creates the full-mix track and section, sets the tempo map, splits the arrangement into analysed sections, creates stem tracks and fills lanes. Deterministic and order-independent. See §6. |
| `track.add` | track, index? | |
| `track.remove` | trackId | Also removes its lanes and clears every `sidechainSource` that pointed at it |
| `track.update` | trackId, patch (name, color, gainDb, pan, mute, solo, hidden) | |
| `fx.add` | scope (track/clip/master), fx, index? | |
| `fx.update` | fxId, paramsPatch, bypass?, sidechainSource? | `sidechainSource: null` clears the routing; an absent field leaves it unchanged |
| `fx.remove` / `fx.reorder` | fxId / fxId, newIndex | |
| `section.insert` | index, section | |
| `section.remove` | sectionId, closeGap: true | |
| `section.move` | sectionId, toIndex | |
| `section.duplicate` | sectionId, toIndex, newId | Deep-copies lanes with new IDs, sets `derivedFrom` |
| `section.resize` | sectionId, lengthTicks, mode: `trim` \| `loop` \| `stretch` | `generate` mode is not an op: the planner produces clip ops with generated assets |
| `section.split` | sectionId, atTick (relative), newId | |
| `section.merge` | sectionIdA, sectionIdB | Must be adjacent |
| `section.update` | sectionId, patch (kind, label, energyTarget, locked) | |
| `section.set_transition` | sectionId, transition | |
| `clip.add` | sectionId, trackId, clip | |
| `clip.update` | clipId, patch | Move, trim, gain, fades, pitch, warp |
| `clip.remove` | clipId | |
| `clip.split` | clipId, atTick, newId | |
| `clip.replace` | clipId, clips[] | Used for AI results: replaces one clip with N |
| `automation.set` | scope (lane or master), target, points | Replaces points in [min,max] tick range of given points |
| `automation.clear` | scope, target, range? | |
| `tempo.set` | tempoMap | Clips with `beatgrid` warp follow the new map |
| `key.transpose` | semitones, scope: `all` \| Region | Adds `semitones` to each clip's `pitchSemitones` in scope (a transpose) |
| `region.clear` | region | Removes/trims clip content in region, adding short fades |
| `region.adopt` | fromCommit, region | Copies content of region from another commit (the "merge best bits" primitive) |

`section.duplicate`, `section.split` and `region.clear` copy clips the payload does not name. Their new IDs are deterministic — `clp_`/`fx_` plus the first 26 characters of the base32 SHA-256 of `derive:<parentId>:<originalId>` — so `apply` stays reproducible and two copies never collide (Q14).

Each op has a JSON Schema in `packages/schemas/song/ops/<op>.schema.json` and a Rust `apply` implementation with unit and snapshot tests.

### 4.3 Validation invariants (enforced after every batch)
1. Every `TrackId` in any lane exists in `tracks`.
2. `lengthTicks > 0` for all sections, `clip.srcStart < clip.srcEnd`, and all clip ranges lie within the asset's duration (asset metadata is supplied to the validator).
3. Overlapping clips in a lane must be covered by matching fades: for an overlap between the earlier clip *a* and the later clip *b*, `a.fadeOutTicks ≥ a.end − b.start` and `b.fadeInTicks ≥ min(a.end, b.end) − b.start`.
4. Tempo map is sorted, starts at 0, and bpm is in [20, 400].
5. FX params are within catalogue ranges.
6. `locked` sections are unchanged by batches authored by `ai`.
7. IDs are unique within the document.
8. A `sidechainSource` is only present on a `sidechain_duck`, names an existing track, and is not the track that owns the duck. `fx.add` and `fx.update` reject a violation as `fx_param` (wrong effect or self-reference) or `unknown_track` (no such track); whole-document validation reports a dangling source as `unknown_track`, like any other dangling reference. `track.remove` clears references to the removed track.

A batch that violates an invariant is rejected with a structured error `{ opIndex, code, message }`.

The schema enforces what a *document* can express: types, enums, ID and hash shapes, ranges, required fields and the closed-object rule. The invariants above span several objects at once (a `TrackId` in a lane must exist; clips must fit their asset; the tempo map must be sorted and start at tick 0), so they are `bragi-model::validate`'s job in WP-0.3, not the schema's. Where a bound is a single-field range (invariant 4's `bpm`, `pan`, `lengthTicks > 0`) the schema declares it too, and TypeScript and Python enforce it; `typify` generates the plain numeric type, so Rust checks it in `validate`.

## 5. Semantics of tricky ops

### 5.1 `section.move` / `section.duplicate`
Content moves with the section because lanes are relative. The `transitionIn` of the moved section, and of the section that now follows its old position, are set to `crossfade` with length = 1 beat if they were `cut` **and** the planner or UI requests smoothing. The UI's default "smart transitions" setting requests it. The AI may later replace the crossfade with a `generated` transition ([09-generation.md §4.4](09-generation.md)).

The v1 `section.move` payload carries no smoothing flag, so WP-0.3 does **not** change transitions on a move; it only re-anchors master automation (Q19). Master automation points carry absolute ticks: a point inside a section keeps its offset from that section's start, and a point past the arrangement scales with the total length.

### 5.2 `section.resize`
- `trim`: shorten/lengthen the window. Clips are cut at the new end with a fade. Lengthening leaves silence.
- `loop`: lengthen by repeating the section's content in whole-bar units.
- `stretch`: time-stretch the section's clips (warp ratio change). Pitch is preserved.

### 5.3 Master automation and reordering
Master automation points carry absolute ticks. When sections move, points lying inside a moved section move with it. Points in gaps are re-anchored proportionally. Implemented in `apply_section_move` with snapshot tests.

### 5.4 `region.adopt`
1. Resolve the region in both the current and the source commit.
2. Remove the current content in the region (as `region.clear`).
3. Copy clips and automation from the source commit's region, preserving relative positions.
4. Add 10 ms equal-power fades at the region boundaries.
If the section structure differs between commits, the region is matched **by absolute ticks**, and the UI warns when boundaries don't align.

### 5.5 `fx.update` and `sidechainSource`
`sidechainSource` is a tri-state patch field. Absent leaves the current routing unchanged; a `TrackId` replaces it; `null` clears it. A duck without a source is valid and behaves as identity (the engine bypasses it). `track.remove` clears every reference to the removed track; undo restores a whole document snapshot, so `track.remove` needs no inverse op for this.

## 6. Applying analysis (`analysis.apply`)

Analysis arrives progressively, one `analysis.apply` op per finished stage ([01 §6](01-architecture.md), [04](04-analysis-pipeline.md)). The op carries the stage's result `blob` and the **effects** — the facts from that blob the document needs, in typed form. That indirection is deliberate: `bragi-model` never reads blobs (it has no I/O, §1.6), so the producer projects the blob into the handful of facts the arrangement is built from, and `bragi-model` records them in `analyses[sourceId].effects`.

`effects[]` is a list of tagged facts, at most one per kind, and each kind belongs to exactly one stage:

| Stage | Effect kind | Payload |
|---|---|---|
| `ingest` | — (empty list) | Starts the source's block: the full-mix track and one `custom` section, "Song", spanning the song |
| `rhythm` | `tempo` | `tempoMap`, `timeSignatures` — the beat grid as a musical grid |
| `structure` | `sections` | `sections[]` — boundaries and labels, the same `StructureSection` the blob holds |
| `separation` | `separation` | `stems[] {role, asset}`, `residual` |
| `tag` | `tags` | `genres[]`, `moods[]` (scores stay in the blob) |
| `describe` | `description` | the plain-language paragraph |
| `harmony`, `loudness_energy`, `energy_stems`, `stem_activity`, `preview`, `embed_full`, `section_embed`, `stem_embed`, `drum_split`, `transcribe`, `lyrics` | — (empty list) | No arrangement change; the op only updates `analyses[src]` |

An effect payload that does not match its stage, two effects of the same kind, or an empty/unsorted/overlapping `sections`/`stems` list is rejected with `{ opIndex, code: "analysis_effects", message }` (§4.3). A stage that owns an effect must carry it: `rhythm` without its tempo map is a producer bug, not a silent no-op.

The stage names in the left column are the `AnalysisStage` enum, and they are the **same** names as the capabilities in [05 §4.1](05-backend-and-jobs.md) and the stage sections of [04](04-analysis-pipeline.md): `loudness_energy` (not "energy"), `tag` (not "tags"), `embed_full`/`section_embed`/`stem_embed` (not "embeddings"), `describe` (not "description"). One name per stage across the specs, the schemas and the capability catalogue.

The `AssetIndex` the caller passes to `apply` — as for every clip op — must hold metadata for the assets the effects introduce (the source's `workingAsset`, every stem and the residual), because invariant 2 checks clip ranges against the asset's length (§4.3).

### 6.1 What each stage builds

`build(source, effects)` is a pure function of the source (`workingAsset`, `durationSamples`) and the **set** of recorded effects. It yields the source's tempo map, its tracks and its sections. Sources are laid out in `sources` order, each block after the previous one (v1's flow has one source). Every analysis-owned entity gets a deterministic ID from `derived_id` (§4.2, Q14), parented on the source or section, so a re-delivered stage produces the same IDs and can never collide with a user's own:

| Entity | ID | Notes |
|---|---|---|
| full-mix track | `trk_` · `derive:<src>:full_mix` | role `full_mix`, hidden once `separation` is recorded |
| stem track | `trk_` · `derive:<src>:stem:<role>` | one per `separation` stem; name and role colour from the design palette |
| residual track | `trk_` · `derive:<src>:residual` | role `residual`, hidden |
| section *i* | `sec_` · `derive:<src>:section:<i>` | `i` is the index in the recorded `sections` effect |
| clip | `clp_` · `derive:<sectionId>:<trackId>` | one per (section, analysis track) |

- **`ingest`** — the block starts with one `custom` section, "Song", spanning the source, and the full-mix clip over the whole working asset.
- **`rhythm`** — sets the block's tempo map and time signatures; analysis clips become `beatgrid`-warped (§6.2). Playback is unchanged because the map matches the source.
- **`structure`** — the section starts become boundaries: seconds → ticks under the block's tempo map, then snapped to the **nearest bar** (§2.2). The first boundary is 0 and the last section runs to the end of the source, rounded **up** to a whole bar so nothing is cut off. Boundaries that snap together merge; a label is the kind plus its recurrence index ("Verse 1", "Verse 2"; "Intro" when the kind occurs once).
- **`separation`** — hides the full-mix track, creates the stem tracks and the residual, each with one clip per section.
- **`tag`/`describe`** — merge into `meta` (§6.3), no arrangement change.

### 6.2 Clip geometry

Each analysis clip covers its section: `start` is 0 because lanes are section-relative, and `srcStart`/`srcEnd` are the section's absolute span in samples of the 48 kHz working asset, clamped to the asset. With a tempo effect the clip is `beatgrid`-warped with anchors at the clip start, every downbeat strictly inside the section, and the clip end — always at least two monotonic anchors, so the scale is defined; without one it is `warp: none`. `provenance.kind` is `transform` for the full-mix clip and `separation` for stem clips, timestamped with the source's provenance date (or the project's `createdAt`), so applying the same stages in any order stamps identical values.

### 6.3 Progressive merge and conflicts

The op records `status[stage] = "done"`, `blobs[stage] = blob` and the merged `effects` (kept in a fixed kind order, so the list is a set and not an arrival log), and updates `analyses[src].stems` from a `separation` effect. `meta` takes only the effects *this op* carries: a `tags` effect merges into `meta.tags` (union, existing order first) and a `describe` effect sets `meta.description` when it is absent — so a re-delivery of an unchanged stage cannot resurrect a tag the user removed, and re-delivering a stage whose effects are unchanged is a no-op.

`build` runs over the effects recorded **before** the op and **after** it:

- **Pristine** — `arrangement.sections` and `timebase` still equal the before-baseline, so nothing has touched the arrangement. The block is replaced with the after-baseline. Since every intermediate document is `build(prefix)` merged into the untouched rest, the final document depends only on the final set: **every permutation of stage arrival yields the same document** (property test in `crates/bragi-model/tests/analysis.rs`).
- **Edited** — the user has changed the arrangement (split, moved, resized, relabelled, added or locked a section, added a clip), so the block no longer matches. Then:
  - the arrangement is **never** touched: no re-split, no reorder, no re-time, no lane overwritten;
  - `structure` writes `meta.suggestedSections` instead of re-splitting, replacing that source's previous suggestions; a later pristine `structure` clears them;
  - `ingest`/`separation` still add the missing tracks and fill **empty** lanes of the existing sections with clips clipped to the source's span, so the song stays playable;
  - the UI accepts a suggestion by turning it into `section.split`/`section.insert` ops, and dismisses it with `project.set_meta`'s `suggestedSections` (an empty list clears them).

`analysis.apply` is applied as a new commit on top of HEAD, like any other op. It is a **system** op, so invariant 6 (AI may not modify locked sections) does not reject it; a locked section is a user edit, though, so it routes the block down the edited path above.

```ts
type AnalysisEffect =
  | { kind: "tempo"; tempoMap: TempoPoint[]; timeSignatures: TimeSig[] }
  | { kind: "sections"; sections: StructureSection[] }
  | { kind: "separation"; stems: { role: StemRole; asset: AssetHash; rmsDb?: number }[]; residual: AssetHash }
  | { kind: "tags"; genres: string[]; moods: string[] }
  | { kind: "description"; description: string };

interface SectionSuggestion {          // meta.suggestedSections, Q13
  sourceId: SourceId;
  startSec: number; endSec: number;    // the analysis truth
  startTick: number; endTick: number;  // the same span on the arrangement's tick grid
  kind: SectionKind;
  label: string;
  confidence?: number;
  repeatGroup?: string;
}
```

## 7. Versioning: the commit DAG

```ts
interface Commit {
  id: CommitId;
  projectId: ProjectId;
  parents: CommitId[];          // 0 for root, 1 normally, 2 never in v1 (no true merges; region.adopt instead)
  batch: OpBatch;
  snapshot: AssetHash;          // zstd-compressed canonical JSON of the full document after this commit
  state: "committed" | "candidate" | "discarded";
  candidateGroup?: string;      // candidates produced by one AI request share a group
  deviceId: string;
  createdAt: ISODate;
}

interface Refs { head: CommitId; branches: Record<string, CommitId>; starred: CommitId[] }
```

Rules:
- **Every commit stores a full snapshot.** Documents are small (budget **< 1 MB** uncompressed for a 10-minute song with 12 tracks), so snapshots dedupe well and make checkout O(1).
- **AI candidates:** an AI request creates N commits with `state: "candidate"` that are children of HEAD and share a `candidateGroup`. Auditioning a candidate checks it out *temporarily* in the engine. **Accepting** a candidate sets it to `committed` and moves HEAD to it. The sibling candidates become `discarded` and stay visible as faded branches for 7 days, then are garbage-collected unless starred.
- **Undo/redo** moves HEAD along the parent chain and a redo stack. Undo never deletes commits.
- **Branching** happens naturally. Making an edit while HEAD is not at a branch tip creates a new branch. The user can name branches ("Club version").
- **Two devices editing offline** produce two branches with a common ancestor. Sync never auto-merges. The UI shows both tips and the user picks one or uses `region.adopt` ([05-backend-and-jobs.md §7](05-backend-and-jobs.md)).

## 8. Public API of `bragi-model` (Rust, exposed to TS via WASM)

```rust
pub fn validate(doc: &Project, assets: &AssetIndex) -> Result<(), Vec<ValidationError>>;
pub fn apply(doc: &Project, batch: &OpBatch, assets: &AssetIndex) -> Result<Project, ApplyError>;
pub fn diff(prev: &Project, next: &Project) -> EngineDelta;          // consumed by bragi-engine
pub fn resolve_region(doc: &Project, region: &Region, assets: &AssetIndex) -> ResolvedRegion;
pub fn section_spans(doc: &Project) -> Vec<SectionSpan>;             // absolute ticks per section
pub fn ticks_to_seconds(doc: &Project, ticks: i64) -> f64;
pub fn seconds_to_ticks(doc: &Project, secs: f64) -> i64;
pub fn summarize_for_llm(doc: &Project, analyses: &AnalysisBundle, focus: Option<&Region>) -> LlmContext; // see 06
pub fn migrate(raw: serde_json::Value) -> Result<Project, MigrateError>;
pub fn canonical_json(doc: &Project) -> String;                      // stable key order, for hashing
```
`AssetIndex` is the `AssetHash → AssetMeta` map the invariants need, because clip ranges are in samples and the asset's length lives outside the document (02 §3.2). `ValidationError` is the structured `{ opIndex, code, message }` of 02 §4.3; `ApplyError` is either one of those (the op itself was bad) or a list of them (the batch left the document invalid). `SectionSpan` and `ResolvedRegion` are owned return shapes; `EngineDelta` (defined in `crates/bragi-model/src/diff.rs`) reports `timebaseChanged`, `metaChanged`, source/track/section adds–removes–updates, `masterChanged`, and `requiresFullResync` for a structural change the engine must rebuild its render plan for. `migrate` (there are no v0 documents yet) and `summarize_for_llm` (it needs the analysis bundle from WP-1.8) are the two entry points still to come.

The WASM wrapper passes documents as JSON strings or `Uint8Array` (MessagePack). Hot paths (`section_spans`, `ticks_to_seconds`) must not re-serialize the whole document. The WASM module keeps a handle-based cache: `load(doc) -> DocHandle`, and later calls take the handle.

## 9. Forward compatibility

- **Real-time collaboration (post-v1):** stable IDs and fine-grained ops make a later move to a CRDT (e.g. Loro or Automerge) feasible, with sections, tracks and clips mapping to CRDT maps and lists. Do not rely on array indices as identity anywhere except `sections` order (moves are explicit ops).
- **New FX/ops:** additive changes bump the minor schema version. Removing or renaming anything requires `migrate`.

## 10. Example document

[`fixtures/projects/example-02-10.json`](../fixtures/projects/example-02-10.json) is this document. WP-0.2's
contract test extracts the block below and asserts the two are equal, and the fixture is what proves
the acceptance criteria: it validates against `Project` in TypeScript, Rust and Python, and
JSON → typed → JSON round-trips losslessly in all three.

`trk_mix`, `sec_01` and `clp_01` are hand-written for readability; §2.1 explains why they are valid
IDs even though they are not ULIDs.

```json
{
  "schemaVersion": 1,
  "id": "prj_01JAB3QK7M9P2V6XWN0T4Y8ZB5",
  "meta": {
    "title": "Midnight Drive",
    "createdAt": "2026-10-18T12:00:00Z",
    "tags": [
      "synthwave",
      "nocturnal"
    ]
  },
  "sources": [
    {
      "id": "src_01JAB4W2C3D4E5F6G7H8J9KMNP",
      "kind": "upload",
      "originalAsset": "sha256:f515ec054ae36e0c457ea84bb68b94c306e3e112f231ac61406b7d570f9d341e",
      "workingAsset": "sha256:4ba509921a4cccb80028e0f42c5c3d2a1e2adfcd080bc018a3d515ef930bbb8a",
      "durationSamples": 11520000,
      "channels": 2,
      "label": "midnight_drive.mp3"
    }
  ],
  "analyses": {
    "src_01JAB4W2C3D4E5F6G7H8J9KMNP": {
      "profile": "standard",
      "status": {
        "rhythm": "done",
        "separation": "running"
      },
      "blobs": {
        "rhythm": "sha256:0782f3efa26c8cdb0a09a96c40aff8c1bb6b83de76a0ae80f438121b1c08b6b7"
      },
      "summary": {
        "bpm": 118,
        "key": "F# minor",
        "durationSec": 240,
        "genres": [
          "synthwave"
        ],
        "moods": [
          "nostalgic",
          "driving"
        ]
      }
    }
  },
  "tracks": [
    {
      "id": "trk_mix",
      "name": "Original mix",
      "role": "full_mix",
      "color": "#8A8F98",
      "gainDb": 0,
      "pan": 0,
      "mute": false,
      "solo": false,
      "hidden": false,
      "fx": []
    }
  ],
  "arrangement": {
    "timebase": {
      "ppq": 960,
      "tempoMap": [
        {
          "tick": 0,
          "bpm": 118,
          "curve": "step"
        }
      ],
      "timeSignatures": [
        {
          "bar": 0,
          "numerator": 4,
          "denominator": 4
        }
      ]
    },
    "sections": [
      {
        "id": "sec_01",
        "kind": "intro",
        "label": "Intro",
        "lengthTicks": 30720,
        "transitionIn": {
          "kind": "cut",
          "lengthTicks": 0
        },
        "lanes": {
          "trk_mix": {
            "clips": [
              {
                "id": "clp_01",
                "asset": "sha256:4ba509921a4cccb80028e0f42c5c3d2a1e2adfcd080bc018a3d515ef930bbb8a",
                "srcStart": 0,
                "srcEnd": 780000,
                "start": 0,
                "warp": {
                  "mode": "beatgrid",
                  "anchors": [
                    {
                      "srcSample": 0,
                      "tick": 0
                    },
                    {
                      "srcSample": 97627,
                      "tick": 3840
                    }
                  ]
                },
                "gainDb": 0,
                "pitchSemitones": 0,
                "fadeInTicks": 0,
                "fadeOutTicks": 0,
                "fadeCurve": "equal_power",
                "provenance": {
                  "kind": "user",
                  "createdAt": "2026-10-18T12:00:00Z"
                }
              }
            ],
            "automation": []
          }
        }
      }
    ],
    "master": {
      "fx": [],
      "automation": [],
      "gainDb": 0
    }
  }
}
```
