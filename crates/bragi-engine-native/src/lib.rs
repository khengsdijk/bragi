//! Desktop glue for `bragi_engine`: cpal audio output, memory-mapped PCM
//! reading and the render thread pool.
//!
//! Native-only — this crate is **not** expected to compile for
//! `wasm32-unknown-unknown` (`specs/13-agent-guide.md` §3).
//!
//! Why native audio on desktop rather than WASM in the webview: lower and more
//! stable latency, no background-tab throttling, no WebKitGTK AudioWorklet
//! quirks on Linux, multithreaded rendering, and memory-mapped access to large
//! files (`specs/01-architecture.md` §3).
//!
//! # Status
//!
//! Scaffold (WP-0.1). Built by **WP-1.1**.
