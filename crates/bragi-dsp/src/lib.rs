//! DSP primitives for Bragi: time-stretch, pitch-shift, filters, dynamics,
//! reverb, loudness measurement and crossfades.
//!
//! Everything here runs on the audio thread, so the house rules apply in full
//! (`specs/13-agent-guide.md` §1): no allocation, locks, I/O, logging or
//! panics in a `process()` path. Allocation belongs in `prepare`-style setup
//! calls that the host runs off-thread.
//!
//! The crate must compile for `wasm32-unknown-unknown`.
//!
//! # Status
//!
//! Scaffold (WP-0.1) plus the `Stretcher` trait and the phase-vocoder implementation chosen in
//! **WP-0.4** ([`stretch`], [ADR-0002](../../specs/decisions/ADR-0002-time-stretch.md)). The FX
//! catalogue follows in **WP-2.3** (`specs/03-audio-engine.md` §6).

pub mod stretch;
