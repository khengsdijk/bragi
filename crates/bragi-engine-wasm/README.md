# bragi-engine-wasm

Browser glue for [`bragi-engine`](../bragi-engine): `wasm-bindgen` bindings and the AudioWorklet
host. Commands in and meters out travel over lock-free ring buffers in a `SharedArrayBuffer`, which
is why the web build requires cross-origin isolation
([01 §3](../../specs/01-architecture.md)).

**Status:** scaffold. Built by **WP-1.1**.
