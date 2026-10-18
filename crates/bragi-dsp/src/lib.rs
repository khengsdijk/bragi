//! DSP primitives for Bragi: time-stretch, pitch-shift, filters, dynamics,
//! reverb, loudness measurement and crossfades.
//!
//! Everything here runs on the audio thread, so the house rules apply in full
//! ([`specs/13-agent-guide.md`] §1): no allocation, locks, I/O, logging or
//! panics in a `process()` path. Allocation belongs in `prepare`-style setup
//! calls that the host runs off-thread.
//!
//! The crate must compile for `wasm32-unknown-unknown`.
//!
//! # Status
//!
//! Scaffold (WP-0.1). The `Stretcher` trait and its chosen implementation
//! arrive with **WP-0.4** (spike → ADR-0002); the FX catalogue follows in
//! **WP-2.3** (`specs/03-audio-engine.md` §6, §7).
