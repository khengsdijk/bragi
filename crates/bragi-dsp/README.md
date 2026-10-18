# bragi-dsp

DSP primitives: time-stretch, pitch-shift, filters, dynamics, reverb, loudness measurement and
crossfades ([03 §6–7](../../specs/03-audio-engine.md)).

**Audio-thread rules apply in full** ([13 §1](../../specs/13-agent-guide.md)): no allocation,
locks, I/O, logging or panics in a `process()` path. Allocation happens in setup calls the host
runs off-thread.

**Status:** `stretch` (WP-0.4) is implemented. `bragi-dsp::stretch` holds the `Stretcher` trait
and `PhaseVocoder`, the pure-Rust phase vocoder chosen in
[ADR-0002](../../specs/decisions/ADR-0002-time-stretch.md). Properties, all under `cargo test`:

- `ratio == 1.0 && semitones == 0.0` is a **bit-exact, zero-latency pass-through** for any block
  partition;
- output does not depend on how the caller slices its blocks (the pull model:
  `input_required` → `process`);
- pitch shift is exact (0.0 % at ±12 semitones) and time-stretch keeps the pitch;
- ±12 % stretch of a drum fixture keeps every hit single (no flamming) by the objective proxies;
- **no allocation** after the constructor (counting `#[global_allocator]` test), no panics/NaNs
  on hostile input;
- the crate builds for `wasm32-unknown-unknown` and runs in an AudioWorklet
  (`stretch-lab/web`).

The spike's lab (fixtures, listening renders, benchmarks, the AudioWorklet page) is
`stretch-lab/` — its own Cargo workspace, nothing in it ships.

The FX catalogue follows in **WP-2.3**.
