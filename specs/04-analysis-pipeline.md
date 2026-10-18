# 04 — Analysis Pipeline

Status: Draft v0.1 · Code: `services/workers/analysis`, `services/workers/embed` · Schemas: `packages/schemas/analysis/`

The analysis pipeline turns one stereo file into everything Bragi shows: stems, beat grid, sections, chords, key, energy, tags, embeddings and a plain-language description.

## 1. Principles

1. **Stages are independent jobs** in a DAG. Each one publishes its result as soon as it finishes ([01-architecture.md §6](01-architecture.md)).
2. **Results are cached by `(assetHash, stage, stageVersion)`.** If two users upload byte-identical files, analysis runs once. The second user still needs the bytes to get a match, so nothing leaks.
3. **Every stage degrades gracefully.** A failed chord stage results in a canvas without a harmony strip and a quiet "couldn't detect chords" note. It never blocks the rest.
4. **All times in analysis blobs are in seconds of the working asset.** Conversion to ticks happens in `analysis.apply` ([02-song-model.md §6](02-song-model.md)).
5. **Models are swappable.** Each stage declares a `stageVersion` (e.g. `separation@htdemucs_6s-1`). Changing the model bumps the version, and old results remain valid for old projects.

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

## 4. Stem separation

| Item | Spec |
|---|---|
| v1 default | **HTDemucs 6-source** (`htdemucs_6s`): vocals, drums, bass, guitar, piano, other |
| Quality option | Band-split RoFormer / Mel-band RoFormer family for **vocals/instrumental** (generally higher vocal quality), combined with Demucs for the rest. To be evaluated in WP-1.3. |
| Deep option | Drum sub-separation (kick, snare, toms, hi-hat, cymbals) with a dedicated drum-separation model. The licence must be verified. |
| Output | One 48 kHz 24-bit FLAC per stem, plus a **residual** = working mix − Σ stems ([02-song-model.md §3.4](02-song-model.md)) |
| Roles | `other` may be sub-labelled later using `tag` on the stem (e.g. "synth", "strings"). The track role stays `other` with a display name such as "Synths". |
| Chunking | 10 s segments with 1 s overlap and linear crossfade (standard Demucs practice). The GPU batch size is tuned per GPU type. |
| Silence | Stems whose RMS is below −60 dBFS for the whole song are dropped (no empty ribbons). |

> **The model landscape moves fast.** WP-1.3 must benchmark current options on the internal eval set (§8) before committing, and record the choice in ADR-0004.

## 5. Musical analysis stages

### 5.1 `rhythm`
- Beat and downbeat tracking with a modern neural tracker. **Beat This!** is the v1 candidate. The **All-In-One** music structure model is an alternative that jointly produces beats, downbeats and segments.
- Output: `beats[]` and `downbeats[]` (sec), a global `bpm`, `tempoCurve[]` (bpm per beat, smoothed), `timeSignature` (numerator/denominator, from the downbeat spacing), `confidence`, and `isTempoStable` (bpm std-dev < 1% → treated as constant tempo).
- Half/double-time ambiguity: prefer bpm in [70, 180]. Store `alternativeBpm`.

### 5.2 `structure`
- Section boundaries and functional labels, using an All-In-One-class model or a boundary model + label classifier.
- Boundaries are **snapped to the nearest downbeat** and then to a 2-/4-bar phrase grid when within ±1 beat.
- Output: `sections[] { startSec, endSec, kind: SectionKind, confidence, repeatGroup }`. Sections with the same `repeatGroup` are repetitions of the same material (Chorus 1/2/3), detected via a self-similarity matrix of beat-synchronous chroma + embeddings.
- Label mapping from model vocabulary → `SectionKind` lives in `taxonomy.json`, e.g. `inst → interlude`, `break → breakdown`, `start/end → (merge into neighbours)`.

### 5.3 `harmony`
- **Key:** beat-synchronous chroma (from bass + other + piano + guitar stems, *excluding drums and vocals*) matched to key profiles, refined by the chord sequence. Output: `key { tonic, mode, confidence }` and `keyChanges[] { atSec, tonic, mode }`.
- **Chords:** a neural chord recogniser (candidate: a transformer chord model, licence verified in WP-1.5) operating on the harmonic stems. Output: `chords[] { startSec, endSec, symbol: "F#m7", root, quality, bass?, confidence }`, aligned to beats.
- **Derived:** `romanNumerals[]` relative to the key, and a `progressionFingerprint` per section: a normalised roman-numeral n-gram sequence such as `i-VI-III-VII`. This is used for constellations ([08-universe.md §5](08-universe.md)).
- Licence caution: some well-known key/chord tools are AGPL/GPL or non-commercial. Prefer permissive code and record the licence for each model in `services/workers/MODELS.md`.

### 5.4 `stem_activity`
- Per stem: gated RMS (−45 dBFS gate, 250 ms hop) → `active[] { startSec, endSec }`, plus `presence` per section (0..1). This drives which ribbons appear and fade in the canvas.

### 5.5 `loudness_energy` and `energy_stems`
- **Loudness:** EBU R128 integrated LUFS, LRA, true peak, short-term LUFS series (hop 0.5 s).
- **Energy curve (hop 0.5 s, 0..1)**, used for the **energy skyline**:
  ```
  energy = normalise( 0.40·loudness_st + 0.25·onset_density + 0.15·spectral_centroid + 0.20·active_stem_weight )
  ```
  Each feature is z-scored per song, then a sigmoid is applied. `active_stem_weight` is only available after separation, so before then its weight is redistributed across the other three. The weights are tunable in `config/energy.toml` and evaluated against a small hand-labelled set.
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
- **Optional secondary embedding** (spike in WP-3.1): a music-representation model (MERT/MuQ class) for "sounds-like" similarity, which can be more musically sensitive than CLAP. Many such checkpoints are non-commercial, so check licences.
- Vectors are stored in Postgres/pgvector (`embeddings` table, see [05-backend-and-jobs.md §5](05-backend-and-jobs.md)) and returned to the client for the Universe.

### 6.2 `tag`
- A **controlled taxonomy** in `packages/schemas/analysis/taxonomy.json`: ~150 genres (hierarchical, e.g. `electronic > house > deep house`), ~60 moods, ~80 instruments, ~200 descriptors (production/timbre words: "dusty", "sidechained", "lo-fi", "wide", "punchy"), and eras (decade-style descriptors).
- Method: **small MLP heads trained on CLAP embeddings** (genre, mood, instrument) using a permissively licensed tagging dataset (e.g. MTG-Jamendo, CC-licensed), plus **zero-shot CLAP similarity** for descriptors. Thresholds are calibrated per label.
- Output: `{ genres: [{label, score}], moods: [...], instruments: [...], descriptors: [...], era?: {label, score} }`. The top-k shown in the UI is genres ≤ 3, moods ≤ 4, descriptors ≤ 6.

### 6.3 `describe`
- **Input:** the structured analysis (summary, sections table §5.6, tags, key/bpm, energy shape). Optionally it also takes a **caption from an audio-language model** (candidate in WP-1.7, licence check required). Claude doesn't hear audio, so it writes from these features.
- **LLM:** Claude via the API, with a fixed system prompt and a JSON output schema:
  ```json
  { "summary": "One paragraph, plain language, no jargon.",
    "sectionNotes": [{ "index": 0, "text": "Sparse filtered piano sets a late-night mood." }],
    "whatMakesItWork": ["The drums drop out for one bar before each chorus, so the chorus lands harder."],
    "suggestedTitle": "optional, only for generated songs" }
  ```
- **Hallucination guard:** the prompt forbids claims not grounded in the provided features (no artist names, no lyric content unless lyrics were transcribed). A post-check rejects descriptions that mention instruments absent from `instruments`/`activeStems`.

## 7. Deep-profile stages

| Stage | Method (candidate) | Output |
|---|---|---|
| `drum_split` | Drum-separation model on the drum stem | kick/snare/toms/hats/cymbals sub-stems |
| `transcribe` | Polyphonic note transcription (e.g. Spotify basic-pitch, Apache-2.0) on bass, piano, guitar, other and vocals | MIDI per stem (`notes[] {pitch, startSec, endSec, velocity}`) |
| `lyrics` | Whisper-class ASR on the vocal stem + forced word alignment | `words[] {text, startSec, endSec}`, `lines[]` |

Lyrics are **shown to the user only** (karaoke-style highlight in the canvas) and fed to the planner as section context. They are never stored publicly or used for training.

## 8. Evaluation set and quality gates

`fixtures/eval/` contains a manifest of **~50 tracks** spanning genres. Audio is stored outside the repo (the owner's own library and CC-licensed music), and the repo holds only references, hand-labelled sections, beats and chords.

| Stage | Metric | Gate (v1) |
|---|---|---|
| separation | SDR per stem vs. reference (where multitracks are available) | Report only. Choose the best of the candidates. |
| rhythm | Beat F-measure (±70 ms) | ≥ 0.85 |
| structure | Boundary hit-rate @ ±3 s | ≥ 0.70. Label accuracy ≥ 0.60. |
| harmony | Chord accuracy (majmin, weighted by duration) | ≥ 0.70. Key accuracy ≥ 0.80. |
| tag | Top-3 genre agrees with a hand label | ≥ 0.70 |
| describe | Manual review checklist (grounded, no jargon, no artist names) | 0 hard failures on the eval set |

A regression job (`pnpm eval:analysis`) runs the eval set and writes a markdown report to `reports/analysis-<date>.md`. A model change is merged only if no gate regresses.

## 9. Model registry and licensing

`services/workers/MODELS.md` is the **mandatory** registry. Each model has: name, version or checkpoint hash, task, code licence, **weights licence**, commercial use allowed (yes/no/unclear), source URL, and the date verified.

Rules:
- A model with a non-commercial weights licence may be used in `local`/`staging` and for personal use. It must be **flagged** and needs replacement before any commercial launch.
- Model weights are pulled at container build time and pinned by hash. Workers never download weights at runtime.

## 10. Failure handling

| Failure | Behaviour |
|---|---|
| Worker crash / timeout | Retry up to 3× with exponential backoff (5 s, 30 s, 2 min), then `stage.failed` |
| Low confidence (e.g. beat confidence < 0.4, as in rubato classical music) | Publish the result with `lowConfidence: true`. The UI shows "free-time" mode: no grid snapping, sections by seconds. |
| Corrupt/undecodable input | `ingest.failed` with a user-facing reason ("This file seems damaged or isn't audio") |
| Too long | Rejected at upload with a clear limit message |
