//! Browser glue for [`bragi_engine`]: `wasm-bindgen` bindings and the
//! AudioWorklet host.
//!
//! Commands into the engine and meters out of it travel over lock-free ring
//! buffers in a `SharedArrayBuffer`, which is why the web build needs
//! cross-origin isolation (COOP/COEP, [`specs/01-architecture.md`] §3).
//!
//! # Status
//!
//! Scaffold (WP-0.1). Built by **WP-1.1**.
