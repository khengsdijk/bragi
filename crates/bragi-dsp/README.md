# bragi-dsp

DSP primitives: time-stretch, pitch-shift, filters, dynamics, reverb, loudness measurement and
crossfades ([03 §6–7](../../specs/03-audio-engine.md)).

**Audio-thread rules apply in full** ([13 §1](../../specs/13-agent-guide.md)): no allocation,
locks, I/O, logging or panics in a `process()` path. Allocation happens in setup calls the host
runs off-thread.

**Status:** scaffold. The `Stretcher` trait and its implementation arrive with **WP-0.4**, whose
acceptance is ADR-0002 plus bit-exact pass-through at ratio 1.0 and no audible flamming at ±12% on
drum fixtures. The FX catalogue follows in **WP-2.3**.
