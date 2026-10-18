//! The Bragi audio engine: render plan compiler, scheduler, audio graph,
//! transport state machine and offline renderer.
//!
//! Platform-free by construction — no output device, no filesystem, no threads
//! of its own. The two thin glue crates `bragi-engine-wasm` and
//! `bragi-engine-native` provide those, so that the same DSP runs in an
//! AudioWorklet and natively on desktop and a conformance test can null one
//! against the other (`specs/01-architecture.md` §3,
//! `specs/03-audio-engine.md`).
//!
//! The crate must compile for `wasm32-unknown-unknown`.
//!
//! # Status
//!
//! Scaffold (WP-0.1). Built by **WP-1.1**, against the timing targets in
//! `specs/03-audio-engine.md` §5.2 and a WASM-vs-native null test at
//! ≤ −90 dBFS.
