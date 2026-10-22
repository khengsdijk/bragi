# 04 — Analysis Pipeline

Status: Draft v0.8 · Code: `services/workers/analysis`, `services/workers/embed` · Schemas: `packages/schemas/analysis/`

The analysis pipeline turns one stereo file into everything Bragi shows: stems, beat grid, sections, chords, key, energy, tags, embeddings and a plain-language description.

## 1. Principles

1. **Stages are independent jobs** in a DAG. Each one publishes its result as soon as it finishes ([01-architecture.md §6](01-architecture.md)).
2. **Results are cached by `(assetHash, stage, stageVersion)`.** If two users upload byte-identical files, analysis runs once. The second user still needs the bytes to get a match, so nothing leaks.
3. **Every stage degrades gracefully.** A failed chord stage results in a canvas without a harmony strip and a quiet "couldn't detect chords" note. It never blocks the rest.
4. **All times in analysis blobs are in seconds of the working asset.** Conversion to ticks happens in `analysis.apply` ([02-song-model.md §6](02-song-model.md)).
5. **Models are swappable.** Each stage declares a `stageVersion` (e.g. `separation@htdemucs_6s-1`). Changing the model bumps the version, and old results remain valid for old projects.
6. **Every stage result has a JSON Schema** in `packages/schemas/analysis/` (WP-0.2), so the worker that produces a blob and the TS/Rust code that consumes it share one contract. Where this document leaves a shape open (the loudness series' hop, the embedding windowing and vector layout), the schema records the current best guess and [15-open-questions.md](15-open-questions.md) names the work package that will settle it.

## 2. Stage DAG

```
                    ┌──────────► rhythm ─────────┬──────────► structure ──┬──► section_embed ─┐
                    │                            │                        │                   │
upload ──► ingest ──┼──────────► loudness_energy ┼────────────────────────┤                   ├──► describe
                    │                            ├──► preview             │                   │
                    │                            │                        │                   │
                    ├──────────► embed_full ──► tag ──────────────────────┤                   │
                    │                                                     │                   │
                    └──────────► separation ──┬──► harmony ───────────────┘                   │
                                              ├──► stem_activity ─────────────────────────────┤
                                              ├──► stem_embed ────────────────────────────────┘
                                              └──► (deep) drum_split, transcribe, lyrics
```
- Edges are data dependencies. Independent branches run in parallel on different workers.
- `loudness_energy` gains per-stem energy once `separation` completes (a second, cheap pass: `energy_stems`).

## 3. Profiles

| Profile | Stages | Target latency (4-min song, one mid-range data-centre GPU, e.g. L4/A10 class) | Use |
|---|---|---|---|
| `quick` | ingest, rhythm, loudness_energy, preview, embed_full, tag | **< 15 s** | Library import (hundreds of songs) for the Universe |
| `standard` | quick + separation, structure, harmony, stem_activity, energy_stems, section_embed, stem_embed, describe | **< 60 s** | Opening a song in the canvas |
| `deep` | standard + drum_split, transcribe (melody/bass → MIDI), lyrics (transcription + alignment) | < 3 min | On demand ("Analyse deeper" button), export to DAW |

Library imports run `quick` and are upgraded to `standard` lazily when a song is first opened. Opening the canvas therefore triggers the remaining stages, with cached results reused.

### 3.1 `ingest`
- Decode with ffmpeg (worker sandbox). Reject files over 30 minutes or 500 MB (configurable).
- Produce the **working asset**: 48 kHz, stereo (mono is duplicated, >2 channels are downmixed), 24-bit FLAC.
- Compute `durationSamples`, an audio fingerprint (Chromaprint, used only for duplicate detection in the user's own library), and a peak pyramid (also computed client-side, but generated here for the Universe thumbnails).
- Output blob: `IngestResult { workingAsset, durationSec, channelsOriginal, sampleRateOriginal, codec, fingerprint }`.
- **Implementation notes (WP-1.2).** Capability `analysis.ingest`; input `assets.source`, outputs `assets.workingAsset` and `blobs.result`.
  Mono is duplicated at unity gain (not ffmpeg's −3 dB up-mix). Decoding is bounded at the duration limit + 1 s, so a container that lies about its length cannot make the worker decode without limit.
  Error codes (all non-retryable): `ASSET_CORRUPT` (undecodable, not audio, or truncated: much less audio decodes than the container declares), `UNSUPPORTED_MEDIA_TYPE` (no audio track), `ASSET_TOO_LONG`, `PAYLOAD_TOO_LARGE`. Chromaprint needs ~3 s of audio; for shorter clips `fingerprint` is `exact:<sha256 of the working PCM, first 32 hex>`, which only matches an identical clip.
  `peakPyramid` is `{ sampleRate, levels: [{ samplesPerPeak, peaks: [min0, max0, min1, max1, …] }] }` on the mono mix (levels of 4096 and 65 536 samples per pair).

## 4. Stem separation

| Item | Spec |
|---|---|
| v1 default | **HTDemucs 6-source** (`htdemucs_6s`): vocals, drums, bass, guitar, piano, other |
| Quality option | Band-split RoFormer / Mel-band RoFormer family for **vocals/instrumental** (generally higher vocal quality), combined with Demucs for the rest. To be evaluated in WP-1.3. |
| Deep option | Drum sub-separation (kick, snare, toms, hi-hat, cymbals) with a dedicated drum-separation model. |
| Output | One 48 kHz 24-bit FLAC per stem, plus a **residual** = working mix − Σ *kept* stems, computed from the stems as stored (24-bit decoded), so `Σ stems + residual` equals the mix exactly and the content of dropped silent stems stays in the residual ([02-song-model.md §3.4](02-song-model.md)) |
| Roles | `other` may be sub-labelled later using `tag` on the stem (e.g. "synth", "strings"). The track role stays `other` with a display name such as "Synths". |
| Chunking | Up to 10 s segments with 1 s overlap and linear crossfade (standard Demucs practice). The segment is clamped to what the model accepts: HTDemucs' transformer is limited to **7.8 s**, so that is what v1 uses. The song is resampled once to the model rate (44.1 kHz) and back, not per chunk. The GPU batch size is tuned per GPU type. |
| Silence | Stems whose RMS is below −60 dBFS for the whole song are dropped (no empty ribbons). |

> **The model landscape moves fast.** WP-1.3 must benchmark current options on the internal eval set (§8) before committing, and record the choice in ADR-0004 (part 1, separation: Proposed, pending the eval-set bake-off).

## 5. Musical analysis stages

### 5.1 `rhythm`
- Beat and downbeat tracking with a modern neural tracker. **Beat This!** is the v1 candidate. The **All-In-One** music structure model is an alternative that jointly produces beats, downbeats and segments.
- Output: `beats[]` and `downbeats[]` (sec), a global `bpm`, `tempoCurve[]` (bpm per beat, smoothed), `timeSignature` (numerator/denominator, from the downbeat spacing), `confidence`, and `isTempoStable` (bpm std-dev < 1% → treated as constant tempo).
- Half/double-time ambiguity: prefer bpm in [70, 180]. Store `alternativeBpm`.
- **Implementation notes (WP-1.2).** Capability `analysis.rhythm`. When the tracked tempo is outside [70, 180] the *beat grid is folded too* (midpoints inserted, or every second beat dropped keeping the downbeats), so `beats`, `tempoCurve` and `bpm` always describe the same pulse; `alternativeBpm` is then the tracker's original reading, otherwise the other octave (double below 125 bpm, half above). `bpm` is a least-squares fit when the tempo is stable (a 20 ms frame grid would otherwise bias a median), the median of the curve when not. `tempoCurve` averages ±4 beats. `timeSignature.numerator` is the most common beats-per-bar; the denominator is fixed at 4 (6/8 cannot be told from 3/4 by beat positions alone). Beat This! reports no confidence: `confidence` = (share of inter-beat intervals within 10 % of their local median) × (share of the song between first and last beat), and `lowConfidence` is `confidence < 0.4`. Audio with no pulse publishes `beats: []`, `confidence: 0`, `lowConfidence: true`, never a failure (§10).

### 5.2 `structure`
- Section boundaries and functional labels, using an All-In-One-class model or a boundary model + label classifier.
- Boundaries are **snapped to the nearest downbeat** and then to a 2-/4-bar phrase grid when within ±1 beat.
- Output: `sections[] { startSec, endSec, kind: SectionKind, confidence, repeatGroup }`. Sections with the same `repeatGroup` are repetitions of the same material (Chorus 1/2/3), detected via a self-similarity matrix of beat-synchronous chroma + embeddings.
- Label mapping from model vocabulary → `SectionKind` lives in `taxonomy.json`, e.g. `inst → interlude`, `break → breakdown`, `start/end → (merge into neighbours)`.
- **Implementation notes (WP-1.4).** Capability `analysis.structure`, `stageVersion` `structure@ssm-novelty-1`. The v1 method is **weight-free** ([ADR-0010](decisions/ADR-0010-structure-segmentation.md)): beat-synchronous chroma + log-mel-DCT timbre + RMS energy → a cosine self-similarity matrix → a Gaussian-tapered Foote checkerboard novelty curve → boundary peaks (at least 8 beats apart, above `mean + 0.25·std` and 0.2·the strongest peak), snapped to the nearest downbeat or, within ±1 beat, a 2- then 4-bar phrase grid, dropping any boundary that collapses within a `MIN_SECTION_BEATS` gap or onto a song edge. `repeatGroup` is a letter per group (A, B, … by first appearance) from an **aligned section similarity** (mean cosine of the trimmed beat rows; 0 when the lengths differ by > 25 %) clustered by average linkage at 0.65. Labels are heuristics over recurrence, relative loudness and position, emitted in the All-In-One vocabulary (`intro verse chorus bridge inst solo break outro`) and mapped to `SectionKind` by `config/structure_labels.json` (`inst → interlude`, `break → breakdown`, `start`/`end` merged into a neighbour); the mapping file stands in for 04 §6.2's `taxonomy.json` until WP-1.6 creates it (Q46). Inputs are `assets.source` and, when the orchestrator wires it, `blobs.rhythm` (the beats are otherwise tracked here with the `rhythm` tracker selection). Failure modes (too short, no pulse, silence, a `rhythm` `confidence` < 0.4) publish one section flagged `lowConfidence`, never a failure (§10). The boundary hit-rate (±3 s), label-accuracy and `repeatGroup` gates and their `PENDING` semantics are the same as rhythm's (§8); the eval manifest gains an optional `labels.sections` file (`<start> <end> <kind> [group]`) and only tracks that carry it count towards the structure gates.

### 5.3 `harmony`
- **Key:** beat-synchronous chroma (from bass + other + piano + guitar stems, *excluding drums and vocals*) matched to key profiles, refined by the chord sequence. Output: `key { tonic, mode, confidence }` and `keyChanges[] { atSec, tonic, mode }`. **Document effect:** the stage's effect is `key { tonic, mode }` ([02 §6](02-song-model.md)); the confidence and the chords stay in the blob, and the arrangement does not change.
- **Chords:** a neural chord recogniser (candidate: a transformer chord model, chosen in WP-1.5) operating on the harmonic stems. Output: `chords[] { startSec, endSec, symbol: "F#m7", root, quality, bass?, confidence }`, aligned to beats.
- **Derived:** `romanNumerals[]` relative to the key, and a `progressionFingerprint` per section: a normalised roman-numeral n-gram sequence such as `i-VI-III-VII`. This is used for constellations ([08-universe.md §5](08-universe.md)).
- **Implementation notes (WP-1.5).** Capability `analysis.harmony`. Input: the harmonic stems `assets.stem_{bass,other,piano,guitar}` when present, else `assets.mix`, else `assets.source` (the orchestrator passes only the upload hash today — Q33). Chroma is computed at 11 025 Hz (STFT n_fft 4096, hop 1024), folding the 65-2100 Hz band into 12 pitch classes and L2-normalising each frame; when a `rhythm` blob is passed the frames are averaged per beat (beat-synchronous chroma), otherwise the frame grid is decoded directly. Key is the Krumhansl-Schmuckler profile correlation of the energy-weighted mean chroma, refined by a 50/50 mix with the duration-weighted chord templates; `key.confidence` is the absolute fit times a scaled margin over the runner-up (silence gives 0). Chords: a root-position template bank (maj, min, dim, aug, sus2/4, maj7, min7, dom7, min7b5, dim7, maj6, min6, minMaj7) plus a "no chord" state, decoded with a change-penalised Viterbi pass; sub-`minChordSec` segments merge away and silent frames become "no chord". `progressionFingerprint` is the roman-numeral sequence with immediate repeats collapsed. **The recogniser is weight-free** ([ADR-0008](decisions/ADR-0008-chord-detection.md)); a `ChordRecognizer` protocol is the seam for a neural model. Because `harmony` depends only on `separation` in the DAG, the per-section progressions use a `structure` blob when one is passed and otherwise publish one whole-song progression at `index: 0`. Audio with nothing to analyse (silence, too short, ambiguous) publishes `lowConfidence: true`, never a failure (§10).

### 5.4 `stem_activity`
- Per stem: gated RMS (−45 dBFS gate, 250 ms hop) → `active[] { startSec, endSec }`, plus `presence` per section (0..1). This drives which ribbons appear and fade in the canvas.
- **Implementation notes (WP-1.6).** Capability `analysis.stem_activity`. Each stem is decoded to mono at 22 050 Hz and gated frame-by-frame: a run of open hops becomes an `active` region, gaps shorter than one hop are closed and runs shorter than one hop are dropped, so a gated hi-hat does not shatter into a click-track. `presence` is the share of in-section open hops (a hop belongs to the section holding its centre). Inputs are the `assets.stem_<role>`; before separation it falls back to `assets.mix` then `assets.source` as the `other` stem (mirrors `harmony`). Sections come from an optional `blobs.structure`; with none, `presence` is `[]`. Silent stems publish an empty `active` and zero presence — never a failure (04 §1.3, §10).

### 5.5 `loudness_energy` and `energy_stems`
- **Loudness:** EBU R128 integrated LUFS, LRA, true peak, short-term LUFS series (hop 0.5 s).
- **Energy curve (hop 0.5 s, 0..1)**, used for the **energy skyline**:
  ```
  energy = normalise( 0.40·loudness_st + 0.25·onset_density + 0.15·spectral_centroid + 0.20·active_stem_weight )
  ```
  Each feature is z-scored per song, then a sigmoid is applied. `active_stem_weight` is only available after separation, so before then its weight is redistributed across the other three. The weights are tunable in `config/energy.toml` and evaluated against a small hand-labelled set.
- **Implementation notes (WP-1.2).** Capability `analysis.loudness_energy`. The formula is `energy = sigmoid( Σ wᵢ · zscore(featureᵢ) )` with the weights of the *available* features renormalised to sum to 1 (before separation there is no `active_stem_weight`, so 0.40 / 0.25 / 0.15 become 0.5 / 0.3125 / 0.1875), and digital silence (short-term loudness at the −70 LUFS floor) pinned to 0. Features per 0.5 s hop: short-term loudness, onset density (peaks of log-spectral flux per second), energy-weighted spectral centroid. The weights live in `bragi_analysis/config/energy.toml`. `shortTermLufs[i]` and `energy[i]` both describe hop `i`: the 3 s short-term loudness is *centred* on the hop's midpoint and truncated at the file edges; both series have `ceil(durationSec / 0.5)` entries; loudness is floored at −70 LUFS (JSON has no −∞). Integrated loudness, LRA and true peak follow BS.1770-4 / EBU Tech 3342 (4× oversampled true peak). `absoluteEnergy` and the per-section aggregates are omitted until library-wide constants and `structure` exist.
- **Absolute energy** (`0..1` comparable across songs) uses library-wide normalisation constants. It feeds the Universe's energy lens.
- Per-section aggregates: `meanEnergy`, `peakEnergy`, `energySlope` (rising/falling), which feed the skyline and the planner.

### 5.6 Section-level summary record
For each section, the pipeline produces a compact record used throughout the UI and by the planner:
```json
{ "index": 3, "kind": "chorus", "repeatGroup": "B", "startSec": 61.2, "endSec": 82.9, "bars": 8,
  "meanEnergy": 0.82, "energySlope": 0.05, "chords": "i-VI-III-VII", "activeStems": ["vocals","drums","bass","other"],
  "tags": ["anthemic", "wide synths"], "loudnessLufs": -7.9 }
```

### 5.7 `preview`
- Depends on `loudness_energy` (and so is part of the `quick` profile). It picks the **12 s window with the highest mean energy**, snapped to start on a downbeat when `rhythm` is available. If `structure` already exists, it prefers a window inside the first chorus or drop.
- Encodes the window as 96 kbps stereo Opus with 0.5 s fades. Output: `PreviewResult { asset, startSec, endSec }`.
- It is not recomputed when later stages arrive. Used for hover-to-hear in the Universe ([08 §7](08-universe.md)) and for style references ([08 §7.2](08-universe.md)).

## 6. AI labelling and description

### 6.1 `embed_full`, `section_embed`, `stem_embed`
- **Primary embedding model: a CLAP-family joint audio–text model** (e.g. LAION-CLAP music checkpoint), producing 512-d L2-normalised vectors. A joint text–audio space is essential, because it powers text search ("sad piano intro") and zero-shot tagging.
- Windowing: 10 s windows with 5 s hop, mean-pooled. Song = pool over the whole song, section = pool within the section, stem = pool over the stem's active regions.
- **Optional secondary embedding** (spike in WP-3.1): a music-representation model (MERT/MuQ class) for "sounds-like" similarity, which can be more musically sensitive than CLAP.
- Vectors are stored in Postgres/pgvector (`embeddings` table, see [05-backend-and-jobs.md §5](05-backend-and-jobs.md)) and returned to the client for the Universe.
- **Implementation notes (WP-1.6).** Capabilities `analysis.embed_full` (whole song), `analysis.section_embed` (one vector per `structure` section) and `analysis.stem_embed` (one vector per stem, pooled over its active regions). Windowing is formalised as 10 s windows with a 5 s hop, each window overlap-weighted by how much of it lies inside the requested scope, summed and L2-normalised (Q16's embedding part). The v1 *target* model is LAION-CLAP `laion/larger_clap_music` (512-d), loaded behind a SHA-256-pinned checkpoint in `BRAGI_MODELS_DIR`; because weights cannot be fetched here, a deterministic weight-free **concept-basis** embedder (`model` `bragi-concept-basis-1`) is the CI/runtime fallback ([ADR-0011](decisions/ADR-0011-embeddings-and-tags.md)). `EmbeddingResult.lowConfidence` is added for silent/too-short audio (04 §10).

### 6.2 `tag`
- A **controlled taxonomy** in `packages/schemas/analysis/taxonomy.json`: ~150 genres (hierarchical, e.g. `electronic > house > deep house`), ~60 moods, ~80 instruments, ~200 descriptors (production/timbre words: "dusty", "sidechained", "lo-fi", "wide", "punchy"), and eras (decade-style descriptors).
- Method: **small MLP heads trained on CLAP embeddings** (genre, mood, instrument) using a tagging dataset (e.g. MTG-Jamendo), plus **zero-shot CLAP similarity** for descriptors. Thresholds are calibrated per label.
- Output: `{ genres: [{label, score}], moods: [...], instruments: [...], descriptors: [...], era?: {label, score} }`. The top-k shown in the UI is genres ≤ 3, moods ≤ 4, descriptors ≤ 6.
- **Implementation notes (WP-1.6).** The file exists at `packages/schemas/analysis/taxonomy.json` (source of truth) and is copied into the worker by `pnpm schemas:gen` (the worker image ships only `services/workers`). It ships **211 genres** (hierarchy to three levels, e.g. `electronic > house > deep-house`), **65 moods**, **88 instruments**, **201 descriptors** and **8 eras**, each with a zero-shot `prompt` template; `config/tag.toml` holds the top-k limits. Genre/mood/instrument use small MLP heads on CLAP embeddings when trained heads are present in `BRAGI_TAG_HEADS`, otherwise every category falls back to zero-shot cosine over the prompts and the result is flagged `lowConfidence` (the field added to `TagResult` for 04 §10). Descriptors and era are always zero-shot. The heads, their training data (MTG-Jamendo, CC) and the per-label thresholds are [ADR-0011](decisions/ADR-0011-embeddings-and-tags.md) owner actions; the training script and notebook live in `services/workers/embed/training/`.

### 6.3 `describe`
- **Input:** the structured analysis (summary, sections table §5.6, tags, key/bpm, energy shape). Optionally it also takes a **caption from an audio-language model** (candidate in WP-1.7). The LLM does not hear audio, so it writes from these features.
- **LLM:** any OpenRouter model (slug in `config/describe.toml`, default `deepseek/deepseek-v4.1-flash`, overridable by `BRAGI_DESCRIBE_MODEL`; key `OPENROUTER_API_KEY`; [ADR-0012](decisions/ADR-0012-describe-llm-client.md)), asked for JSON via `response_format` (json_schema, falling back to json_object), with a fixed system prompt and a JSON output schema:
  ```json
  { "summary": "One paragraph, plain language, no jargon.",
    "sectionNotes": [{ "index": 0, "text": "Sparse filtered piano sets a late-night mood." }],
    "whatMakesItWorks": ["The drums drop out for one bar before each chorus, so the chorus lands harder."],
    "suggestedTitle": "optional, only for generated songs" }
  ```
- **Hallucination guard:** the prompt forbids claims not grounded in the provided features (no artist names, no lyric content unless lyrics were transcribed). A post-check rejects descriptions that mention instruments absent from `instruments`/`activeStems`.

## 7. Deep-profile stages

| Stage | Method (candidate) | Output |
|---|---|---|
| `drum_split` | Drum-separation model on the drum stem | kick/snare/toms/hats/cymbals sub-stems |
| `transcribe` | Polyphonic note transcription (e.g. Spotify basic-pitch) on bass, piano, guitar, other and vocals | MIDI per stem (`notes[] {pitch, startSec, endSec, velocity}`) |
| `lyrics` | Whisper-class ASR on the vocal stem + forced word alignment | `words[] {text, startSec, endSec}`, `lines[]` |

Lyrics are **shown to the user only** (karaoke-style highlight in the canvas) and fed to the planner as section context. They are never stored publicly or used for training.

## 8. Evaluation set and quality gates

`fixtures/eval/` contains a manifest of **~50 tracks** spanning genres. Audio is stored outside the repo (the owner's own library and freely available music), and the repo holds only references, hand-labelled sections, beats and chords.

| Stage | Metric | Gate (v1) |
|---|---|---|
| separation | SDR per stem vs. reference (where multitracks are available) | Report only. Choose the best of the candidates. |
| rhythm | Beat F-measure (±70 ms) | ≥ 0.85 |
| structure | Boundary hit-rate @ ±3 s | ≥ 0.70. Label accuracy ≥ 0.60. |
| harmony | Chord accuracy (majmin, weighted by duration) | ≥ 0.70. Key accuracy ≥ 0.80. |
| tag | Top-3 genre agrees with a hand label | ≥ 0.70 |
| describe | Manual review checklist (grounded, no jargon, no artist names) | 0 hard failures on the eval set |

A regression job (`pnpm eval:analysis`) runs the eval set and writes a markdown report to `reports/analysis-<date>.md`. A model change is merged only if no gate regresses.

**Gate semantics (WP-1.2).** A gate is `PASS` or `FAIL` only when *every* track in `fixtures/eval/manifest.json` was scored with the v1 model; no tracks, missing audio, a hash mismatch or a fallback tracker give `PENDING` and no number. Synthetic click tracks (generated, exact ground truth) prove the harness in a separate report section and never decide a gate. The beat F-measure is `mir_eval.beat.f_measure` at ±70 ms with no trimming of the first seconds, scored on the published (folded) grid. The manifest format is in `fixtures/eval/README.md`.

**Gate semantics (WP-1.5).** The harmony gate is chord accuracy (majmin, duration-weighted) ≥ 0.70 and key accuracy ≥ 0.80, both on the eval set. Chord accuracy is `mir_eval.chord.evaluate(...)["majmin"]` over the published chord segments; key accuracy is the share of tracks whose `key` matches the hand label. **Neither has been run: `fixtures/eval/manifest.json` lists no tracks** (Q32), so both are `PENDING`. The synthetic chord/key suite proves the machinery and is never the gate. The WP-1.2 harness scores `rhythm` only; scoring harmony needs the eval-set manifest to carry chord and key labels (Q65).

**Gate semantics (WP-1.6).** The `tag` gate is top-3 genre agreement ≥ 0.70 and the text query `"drums"` ranks the drum stem above the other stems for ≥ 90 % of eval songs. Both are `PENDING`: the first needs the eval set (Q32) *and* trained heads (no labelled training data here, Q67); the second needs the eval set's per-stem references. The `"drums"`-ranking *metric* is proven on a synthetic multi-stem fixture through the deterministic concept-basis fallback embedder (`test_the_text_query_drums_ranks_the_drum_stem_highest`) — that proves the embedding/tagging wiring and the ranking metric, not the CLAP model, and is reported as synthetic. The WP-1.2 harness does not score embeddings yet; it prints the `tag` gate row as `not implemented yet`/`PENDING`.

## 9. Model registry

`services/workers/MODELS.md` is the **mandatory** registry. Each model has: name, version or checkpoint hash, task, source URL, and the date verified.

Rules:
- Model weights are pulled at container build time and pinned by hash. Workers never download weights at runtime.
- **WP-1.6** pins the v1 embedding target **LAION-CLAP `laion/larger_clap_music`** (512-d) in [services/workers/MODELS.md](../services/workers/MODELS.md); the exact commit and the file SHA-256 are **PENDING** (the weights were not downloadable here, Q68) and the loader refuses an unverified checkpoint. The deterministic concept-basis fallback (`bragi-concept-basis-1`) and the trained tag heads are recorded there too.

## 10. Failure handling

| Failure | Behaviour |
|---|---|
| Worker crash / timeout | Retry up to 3× with exponential backoff (5 s, 30 s, 2 min), then `stage.failed` |
| Low confidence (e.g. beat confidence < 0.4, as in rubato classical music) | Publish the result with `lowConfidence: true`. The UI shows "free-time" mode: no grid snapping, sections by seconds. |
| Corrupt/undecodable input | `ingest.failed` with a user-facing reason ("This file seems damaged or isn't audio") |
| Too long | Rejected at upload with a clear limit message |
