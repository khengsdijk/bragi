# 03 — Audio Engine

Status: Draft v0.5 · Crates: `bragi-dsp`, `bragi-engine`, `bragi-engine-wasm`, `bragi-engine-native`

## 1. Responsibilities

| # | Responsibility | Real-time? |
|---|---|---|
| E1 | Decode assets (FLAC/WAV/MP3/AAC/OGG/M4A) into PCM | No (background) |
| E2 | Play the arrangement with sample-accurate timing, loop, seek, solo/mute | **Yes** |
| E3 | Preview edits live during drags (clip offsets, gains, fx params) | **Yes** |
| E4 | Audition AI candidates (instant A/B switch between commits) | **Yes** |
| E5 | Offline render (mixdown, stems, render caches, generation context) | No |
| E6 | Export to WAV/FLAC/MP3, stems, DAW bundle | No |
| E7 | Produce visual data: waveform peak pyramids, spectrogram tiles, live meters, spectrum | Mixed |
| E8 | DSP: time-stretch, pitch-shift, fx catalogue, loudness, crossfades, seam smoothing | Both |

## 2. Crate layering

```
bragi-dsp            pure DSP, no allocation in process(), no I/O, no threads. Compiles to native + wasm32.
   ▲
bragi-engine         graph, render plan, transport state machine, chunk cache interface, offline renderer.
   ▲                 Platform-free: talks to the outside world through traits (AssetSource, Clock, OutputSink).
   ├── bragi-engine-wasm    AudioWorklet glue, SharedArrayBuffer ring buffers, decoder worker protocol
   └── bragi-engine-native  cpal output, mmap PCM cache, rayon thread pool, Tauri command handlers
```
`bragi-engine` depends on `bragi-model` (for `EngineDelta` and the time mapping), never the other way round.

## 3. Hosts and parity

### 3.1 Browser host (`WasmEngineHost`)
```
Main thread (React)                Decoder Worker(s)                 AudioWorklet (real-time)
 EngineHost.send(cmd) ──SAB ring──────────────────────────────────►  engine.process(128 frames)
 EngineHost.onState  ◄──SAB state block (playhead, meters)─────────  writes atomics every quantum
                                    decode(asset, chunk) ──SAB chunk pool──► engine reads PCM chunks
 BlobCache (OPFS) ─────────────────► reads FLAC bytes
```
- The worklet runs `bragi-engine` compiled to `wasm32-unknown-unknown`, with a **render quantum of 128 frames** at the AudioContext rate. The AudioContext is created at 48 kHz. If the browser refuses, the engine resamples on output.
- **Commands** use a lock-free SPSC ring buffer in a SharedArrayBuffer (main → worklet). **State** uses a fixed-layout SAB block: transport state, playhead sample, and per-track peak/RMS, written by the worklet with `Atomics.store` and read by the UI each animation frame.
- **PCM is never fully resident.** Working assets are decoded on demand in **2-second chunks** (96 000 frames × channels × f32) into a **shared chunk pool** (default 256 MB, LRU). The engine requests chunks ahead of the playhead (prefetch window 6 s, plus 2 s behind for scrubbing). A missing chunk produces silence for that clip, an `underrun` counter increment, and a warning event. This must be rare in practice.
- Requires cross-origin isolation (COOP/COEP), see [01-architecture.md §3](01-architecture.md).
- WP-1.1 defaults: the pool is sized from the 2 s chunk length and a 256 MB budget
  (`ChunkPool::with_defaults`), so the resident-chunk count follows from those two numbers. Missing
  chunks are silence, one `underrun` counter increment and one event in a fixed-size ring.

### 3.2 Desktop host (`TauriEngineHost`)
- `bragi-engine-native` runs in the Tauri Rust process. Audio output goes through **cpal** with a default buffer of **256 frames** (configurable 64–2048) and device selection in Settings.
- Decoded PCM is written to a **PCM cache** on disk (`<appCache>/pcm/<assetHash>.f32`, raw interleaved f32 at 48 kHz) and **memory-mapped**. No chunk pool is needed, because the OS page cache does the work.
- UI ↔ engine: Tauri `invoke` for commands and a Tauri **Channel** streaming `EngineState` at 60 Hz (playhead, meters).
- Offline renders use a rayon pool (parallel per track, then sum).

### 3.3 The `EngineHost` interface (TypeScript, `packages/platform`)
```ts
interface EngineHost {
  init(opts: { sampleRate: 48000; outputDeviceId?: string }): Promise<void>;
  loadDocument(doc: ProjectJson): Promise<void>;          // full load (project open)
  applyDelta(delta: EngineDelta): void;                   // after each commit
  setPreview(preview: PreviewPatch | null): void;          // transient drag state, see §5.3
  transport(cmd: TransportCmd): void;                      // play, pause, stop, seek, loop, scrub
  audition(target: { commitId: CommitId; doc: ProjectJson } | null): void; // §5.4
  render(job: RenderJob): Promise<RenderResult>;           // offline, §9
  peaks(asset: AssetHash, level: PeakLevel): Promise<Float32Array>;
  spectrogram(asset: AssetHash, tile: TileSpec): Promise<Uint8Array>;
  onState(cb: (s: EngineState) => void): Unsubscribe;      // 60 Hz
  onEvent(cb: (e: EngineEvent) => void): Unsubscribe;      // underrun, device change, errors
  dispose(): Promise<void>;
}
```
Both hosts must pass the same **engine conformance suite** (`packages/platform/conformance`): it loads fixture projects, renders them offline, and compares against golden files (see §11).

## 4. Render plan

The engine never interprets the document in the audio thread. On each `loadDocument`/`applyDelta`, a **planner thread** compiles a `RenderPlan`:

```rust
struct RenderPlan {
    sample_rate: u32,
    length_samples: u64,
    tracks: Vec<TrackPlan>,          // ordered, with fx chains instantiated (pre-allocated)
    master: MasterPlan,
    sections: Vec<SectionSpanSamples>,
    plan_version: u64,
}
struct TrackPlan { id: TrackId, segments: Vec<Segment>, fx: Vec<FxNode>, gain: Smoothed, pan: Smoothed, mute: bool, solo: bool, automation: Vec<AutomationLane> }
struct Segment {                      // one clip occurrence, flattened to absolute samples
    clip_id: ClipId, asset: AssetHash,
    dst_start: u64, dst_end: u64,     // absolute output samples
    src_map: SrcMap,                  // dst sample → src position (piecewise linear from warp anchors + tempo map)
    stretch: Option<StretchParams>, pitch_semitones: f32,
    gain: f32, fade_in: Fade, fade_out: Fade, reverse: bool, fx: Vec<FxNode>,
}
```
- The plan is swapped into the audio thread atomically (`arc-swap` on native; an epoch-flagged double buffer on WASM). The audio thread **never allocates, locks or does I/O**.
- Plan compilation for a 10-minute, 12-track song must take **< 20 ms** native and **< 60 ms** WASM. Deltas should recompile only affected tracks.
- Parameter changes (gain, fx params) are **smoothed** over 10 ms to avoid zipper noise.

WP-1.1 pinned the parts this sketch left open:

- **`SrcMap`** is an ordered list of `(dst_offset, src_sample)` breakpoints, interpolated
  linearly and extrapolated with the slope of the outermost interval. `dst_offset` is relative to
  the segment's `dst_start`; `src_sample` is absolute in the asset, which is what a chunk-pool or
  mmap lookup needs.
- **A beatgrid becomes segments.** Its anchors are converted to absolute output samples; the clip
  is split wherever the local rate changes, and pieces whose time ratio differs by less than
  `1e-6` are coalesced. A piece stays on the bit-exact direct path while its ratio is 1, the asset
  is at the output rate and no pitch shift is requested; otherwise it drives a `PhaseVocoder`
  allocated by `Renderer::new` (never by `process`).
- **`TrackPlan.solo`** exists: the "any solo" rule is resolved at compile time, and the renderer
  ramps the resulting audible gain.
- **Sections window their clips.** A clip occurrence is trimmed at its section's end, because a
  section is the arrangement's window (02 §3.5).
- **Automation** in v1 is gain only (`track:<id>/gainDb`, `master/gainDb`, already converted to
  absolute samples by the compiler). Fx parameters arrive with WP-2.3, which also supplies
  `FxNode`; `TrackPlan.fx` is empty in WP-1.1.
- **Solo/mute ramps are linear over exactly 5 ms** (`MUTE_RAMP_MS`); gain, pan and fx parameters
  ramp over 10 ms (`PARAM_RAMP_MS`). A plan swap carries the current ramp *value* over for tracks
  that survive, so flipping mute is a ramp, not a click.
- **Reverse with stretch/pitch is not supported** by the vocoder's forward pull model in v1; those
  clips are rendered on the varispeed direct path and the planner emits a warning (Q29).
- **The loop crossfade is equal-power over exactly 5 ms** (`LOOP_FADE_MS`) and is applied *after*
  the sample-exact wrap point: the first frame after the loop end is the loop start's first frame.

## 5. Transport and real-time behaviours

### 5.1 State machine
`Stopped → Playing ⇄ Paused`, `Playing → Looping(region)`, `any → Scrubbing (while dragging the playhead) → previous state`, plus an `Auditioning(commit)` overlay that can be active in Playing or Looping.

### 5.2 Timing requirements
| Metric | Target |
|---|---|
| Play start latency (chunks cached) | < 100 ms |
| Seek | < 50 ms to audible |
| Loop boundary | Sample-accurate, 5 ms crossfade at the loop point |
| Solo/mute | Applied within one buffer, 5 ms ramp |
| Playhead drift vs `AudioContext.currentTime` / device clock | < 1 ms over 10 min |

Measured by WP-1.1 in `crates/bragi-engine/tests/timing.rs`: play start 0 samples (rendering
begins at the playhead's first frame when the chunks are resident); seek ≤ 1 block (128 samples =
2.7 ms); the loop wrap starts the incoming material on the exact frame after the loop end with a
240-sample equal-power crossfade; mute/solo is silent after 240 samples; the playhead is an integer
sample counter, so ten minutes of playback drift by 0 samples.

### 5.3 Live preview (`setPreview`)
During a drag, the UI sends a lightweight `PreviewPatch`, for example `{ moveSection: { id, toIndex } }`, `{ clipOffset: { clipId, deltaTicks } }`, `{ trackGain: { trackId, db } }`, `{ fxParam: { fxId, param, value } }`, or `{ macro: { trackId, macroId, value } }`. The engine applies the patch to a **shadow plan** without recompiling the whole document. On commit, the UI clears the preview and sends the real `applyDelta`.

### 5.4 Audition (A/B)
`audition(commit)` compiles a second plan for the candidate commit and **crossfades (30 ms) between plans at the same playhead position**. Switching between the original and candidates 1/2/3 must be instant and gapless. This is the key interaction for AI edits ([07-song-canvas.md §6](07-song-canvas.md)). At most **4 plans** are kept warm (HEAD + 3 candidates).

## 6. DSP catalogue (`bragi-dsp`)

The catalogue is described in `crates/bragi-dsp/fx_catalog.json`, which is the single source shared with the UI (controls), planner (allowed params), and validator (ranges).

| FxType | Params (range, default) | Notes |
|---|---|---|
| `gain` | `db` (−60..+12, 0) | |
| `eq3` | `lowDb`, `midDb`, `highDb` (−18..+18, 0); `lowHz` (40..400, 120), `highHz` (2k..12k, 6k), `midHz` (300..5k, 1k), `midQ` (0.3..4, 0.7) | Shelf/bell/shelf, RBJ biquads |
| `filter` | `mode` (0=LP, 1=HP, 2=BP), `cutoffHz` (20..20k), `resonance` (0..1, 0.2) | 24 dB/oct SVF, cutoff smoothed exponentially |
| `compressor` | `thresholdDb` (−60..0, −18), `ratio` (1..20, 3), `attackMs` (0.1..100, 10), `releaseMs` (10..1000, 120), `makeupDb` (0..24, 0), `mix` (0..1, 1) | Feed-forward, RMS/peak blend |
| `saturation` | `drive` (0..1, 0.2), `tone` (−1..1, 0), `mix` (0..1, 1) | Oversampled ×2 tanh/asym |
| `reverb` | `size` (0..1, 0.5), `decaySec` (0.2..12, 2), `predelayMs` (0..200, 20), `damping` (0..1, 0.5), `mix` (0..1, 0.2) | FDN reverb, 8 lines |
| `delay` | `timeBeats` (1/16..2, 1/4), `feedback` (0..0.95, 0.35), `tone` (0..1, 0.5), `pingPong` (0/1), `mix` (0..1, 0.2) | Tempo-synced via tempo map |
| `width` | `width` (0..2, 1) | M/S |
| `transient` | `attack` (−1..1, 0), `sustain` (−1..1, 0) | Envelope-difference shaper |
| `lofi` | `bits` (4..16, 16), `rateHz` (2k..48k, 48k), `wow` (0..1, 0), `noise` (0..1, 0), `mix` (0..1, 1) | Tape/vinyl flavour |
| `chorus` | `rateHz` (0.05..5, 0.6), `depth` (0..1, 0.3), `mix` (0..1, 0.3) | |
| `sidechain_duck` | `sourceTrack` (TrackId), `amountDb` (0..24, 6), `releaseMs` (20..800, 150) | Envelope follower on the source track |
| `match_eq` | `bands` (31 × dB, hidden), `amount` (0..1, 1) | Auto-generated for seam smoothing (§8.2), not user-facing |
| `limiter` | `ceilingDb` (−6..0, −1), `releaseMs` (1..500, 50) | Master only, look-ahead 5 ms, true-peak |

The master always ends with a **safety limiter** (ceiling −0.3 dBTP) that the user cannot remove. It's there for ear and speaker safety.

### 6.1 Macros ("vibe controls")
Macros are named, plain-language controls that drive several fx params at once. They are defined in `crates/bragi-dsp/macros.json`:
```json
{ "id": "brightness", "label": "Darker ↔ Brighter", "range": [-1, 1],
  "drives": [ { "fx": "eq3", "param": "highDb", "curve": [[-1,-9],[0,0],[1,6]] },
              { "fx": "filter", "param": "cutoffHz", "curve": [[-1,3500],[0,20000],[1,20000]], "mode": 0 } ] }
```
v1 macros: `brightness`, `space` (reverb + width), `punch` (transient + compressor), `warmth` (saturation + eq), `vintage` (lofi + eq + saturation), `intensity` (drive, compression, transient, small level change), and `distance` (filter, reverb, level). Applying a macro creates or updates fx instances tagged `macroOwned`, so the UI can show "controlled by Space".

`crates/bragi-dsp/macros.json` is the source of truth for the definitions; its schema is
`packages/schemas/dsp/macros.schema.json`, and `crates/bragi-dsp/fx_catalog.json`'s is
`packages/schemas/dsp/fx-catalog.schema.json`. `pnpm schemas:gen` validates both and copies them into
`@bragi/schemas` as the typed modules `MACROS` and `FX_CATALOG`, which TypeScript consumers (the app,
the planner) import instead of reading the JSON themselves.

## 7. Time-stretch and pitch-shift

Behind a trait in `bragi-dsp::stretch`; the implementation chosen in
[ADR-0002](decisions/ADR-0002-time-stretch.md) is the pure-Rust phase vocoder `PhaseVocoder`
(Signalsmith Stretch is evaluated and held for offline renders; Rubber Band is a candidate
for the quality bake-off). The trait is:

```rust
pub trait Stretcher: Send {
    fn configure(&mut self, ratio: f64, semitones: f32, quality: Quality) -> Result<(), StretchError>;
    fn input_required(&self, out_frames: usize) -> usize;
    fn process(&mut self, input: &[&[f32]], out: &mut [&mut [f32]]);
    fn latency(&self) -> usize;
    fn look_ahead(&self) -> usize;
    fn reset(&mut self);
    fn ratio(&self) -> f64;
}
```

The clarifications WP-0.4 pinned down:

- **Ratio direction:** `ratio` is *time ratio = output duration / input duration*. `ratio > 1` is
  longer/slower. `semitones` shifts pitch at constant duration; the two are independent.
- **Channels go together.** `process` takes every channel at once (`&[&[f32]]` →
  `&mut [&mut [f32]]`). A mono-per-instance API cannot hold a stereo image, because transient
  detection and phase propagation must be shared across channels; a left/right pair would drift.
- **Pull model.** `input_required(out_frames)` is exactly how many input frames the next `process`
  call consumes. It depends only on the ratio/pitch history, never on how the caller slices its
  blocks, so 128-frame (AudioWorklet), 256-frame (cpal) and the offline renderer agree. Feeding
  silence past the end of the source is the caller's job; `look_ahead()` bounds the read-ahead for
  prefetching.
- **Allocation is constructor-only.** `configure`, `process`, `input_required`, `latency`,
  `look_ahead` and `reset` never allocate; both quality tiers are allocated in the constructor so
  switching tier on the audio thread is free.
- **Latency.** `latency()` is constant per quality tier (independent of `ratio` and `semitones`);
  a click at input frame `t` appears at output frame `latency() + ratio·t`.
- **Pass-through.** `ratio == 1.0 && semitones == 0.0` is a bit-exact copy with zero latency for
  any block sizes, so un-warped stems bypass the vocoder entirely.

- **Quality tiers:** `Preview` (real-time, low CPU, used during playback) and `Render` (high quality, used in offline renders and render caches).
- Flam proxies, CPU measurement and the listening check live in
  [`docs/wp/0.4.md`](../docs/wp/0.4.md) and [`docs/wp/0.4-MANUAL_CHECKS.md`](../docs/wp/0.4-MANUAL_CHECKS.md).

## 8. Separation-aware mixing and seam smoothing

### 8.1 Residual management
With unedited stems, `Σ stems + residual ≈ mix`. When the user changes stems, the residual carries bleed that may no longer belong:
- **Residual gain rule:** `g_res = Σ_i (e_i · u_i) / Σ_i e_i`, where `e_i` is stem *i*'s energy share in that section (from analysis) and `u_i ∈ [0,1]` is how "unmodified" stem *i* is. `u_i` is 1 if untouched, 0 if muted, replaced or swapped, and 0.5 for fx-only edits. It is computed per section by the render planner.
- **"Clean solo"**: when a single stem is soloed, the residual is muted and an optional light spectral-gate post-filter (`bragi-dsp::spectral_gate`) reduces separation "warble".
- Heavy artifacts are addressed upstream by better separation models ([04-analysis-pipeline.md §4](04-analysis-pipeline.md)) and optionally by **stem resynthesis** ([09-generation.md §4.6](09-generation.md)).

### 8.2 Seam-smoothing toolkit (used by generation and section moves)
| Tool | Function |
|---|---|
| `equal_power_crossfade(a, b, len)` | Standard crossfades, with phase-aware alignment: cross-correlation search ±10 ms to pick the least-cancelling offset |
| `loudness_match(clip, context)` | Matches short-term LUFS of a clip's first and last 2 s to the surrounding context, applying a gain ramp |
| `spectral_match(clip, context)` | Computes 31-band average spectra and creates a `match_eq` fx so the clip's spectral tilt matches the context (limited to ±6 dB per band) |
| `beat_align(clip, grid)` | Snaps the clip's detected onsets to the beat grid via warp anchors (max ±30 ms adjustment) |
| `seam_score(render, seamPos)` | Objective measure for auto-selecting candidates: spectral flux jump, loudness jump and onset regularity across a seam. Lower is better. |

## 9. Offline render and export

```ts
type RenderJob =
  | { kind: "mixdown"; range?: TickRange; format: AudioFormat; normalize?: { lufs: number; truePeakDb: number } }
  | { kind: "stems"; tracks: TrackId[] | "all"; format: AudioFormat }
  | { kind: "context"; range: TickRange; tracks: TrackId[] | "all" }   // for generation conditioning, 48k WAV
  | { kind: "cache"; sectionId: SectionId };                           // pre-rendered HQ section audio
type AudioFormat = { container: "wav"; bits: 16 | 24 | 32 } | { container: "flac"; bits: 16 | 24 } | { container: "mp3"; kbps: 128 | 192 | 320 };
```
- Offline render uses the `Render` stretch quality and is **deterministic**, with no dither randomness unless a seed is supplied. WP-1.1 fixes the block size at 512 frames (`OFFLINE_BLOCK`), so a mixdown is host-independent.
- **Implemented in v1 (WP-1.11):** `mixdown` and `stems` to WAV (16/24-bit integer, 32-bit float) and FLAC (16/24-bit). `RenderResult` carries `files: { name, bytes, frames }[]` (one file for a mixdown, one per track in document order for stems). `context`, `cache`, MP3 and `normalize` are rejected with a typed error until their work packages land.
- Encoding lives in `bragi_engine::export` (platform-free), so WASM and native emit the same files. Dither is TPDF (xorshift64\*), applied to 16/24-bit output only when `ditherSeed` is given. A `range` in ticks must be converted by the caller to `startSample`/`frames` (the tempo map is `bragi-model`'s); the host rejects an unconverted range instead of exporting the whole song.
- **Naming and metadata:** the mixdown is `<title>.<ext>`; a stem is `<NN>-<track name>.<ext>` with `NN` the track's 1-based document position. Names keep letters, digits, space, `_` and `-`. Metadata (title, BPM and key in the comment, the stem's track name, the caller's creation date, encoder `Bragi <version>`) goes into WAV `LIST/INFO` and FLAC Vorbis comments. The engine never reads the clock.
- **Stems** are rendered per track with mute/solo ignored (a stem is the track as written), master gain kept, and the safety limiter bypassed, so stems sum to the mixdown whenever the mixdown limiter is not engaged. The mixdown keeps the safety limiter (the user cannot remove it), which means a mixdown only nulls against an asset that peaks below -0.3 dBFS (Q38). Native stems render in parallel on a rayon pool (`parallel` feature of `bragi-engine`, enabled by `bragi-engine-native`); WASM renders them sequentially. Output is identical either way.
- **FLAC** is written by an in-repo encoder (fixed predictors 0-4, partitioned Rice, stereo decorrelation, MD5 in STREAMINFO, 4096-sample blocks; a remainder under 16 samples switches the stream to variable block size because decoders reject a shorter last block).
- **Wire format:** hosts return the files as one binary *export frame* (`"BXPT" | u32 LE jsonLen | json | file bytes…`, `ExportResult::to_frame`, read by `decodeExportFrame`), so Tauri never serialises megabytes of audio as a JSON array.
- **Export bundle ("Open in your DAW")**: a zip containing stems aligned to bar 1 (24-bit WAV), `tempo_and_markers.mid` (tempo map + section markers), `chords.mid` (if harmony analysis is present), and a `README.txt` listing BPM, key and section times. A native Ableton `.als` export is post-v1.
- The MP3 encoder is chosen in a later export work package (not WP-1.11, whose scope is WAV/FLAC; Q37). It must compile on all targets. In the browser it may run as a separate WASM module in a worker.

## 10. Visual data

| Data | Producer | Spec |
|---|---|---|
| Peak pyramid | Decoder worker / native thread on first load of an asset | Min/max pairs at 256, 1024, 4096 and 16384 samples per bin, cached in BlobCache as `peaks/<hash>.bin` |
| Spectrogram tiles | Same, on demand | Mel 128 bins, hop 512, tile = 1024 frames, u8 log-magnitude, cached |
| Live meters | Audio thread | Per track: peak + RMS at 60 Hz. Master: momentary LUFS + 64-band spectrum (for the "alive" visuals). WP-1.1 ships peak + RMS for tracks and master, in a fixed-word state block (`bragi_engine::rt::StateBlock`); momentary LUFS needs K-weighting and the 64-band spectrum needs an FFT, so both are Q26. |
| Section energy | From analysis (not the engine) | See [04-analysis-pipeline.md §5.6](04-analysis-pipeline.md) |

## 11. Testing

- **Golden renders:** `fixtures/projects/*.json` + `fixtures/audio/*` (self-made). Offline render output is compared with `insta`-stored hashes and a **null test** (residual ≤ −90 dBFS) against golden WAVs.
- **Parity:** the same fixtures rendered via WASM (in Node with a WASM runtime) and native must null to ≤ −90 dBFS.
- **Real-time safety:** a custom allocator in debug builds panics if the audio thread allocates (`assert_no_alloc`).
- **Stress:** 24 tracks × 4 fx × 10 minutes with no underruns at 128 frames (browser, mid-range laptop) or 256 frames (desktop).
- **Fuzz:** random op sequences → apply → plan → render 1 s. No panics, no NaNs or Infs in output.
