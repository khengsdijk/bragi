# bragi-engine-wasm

Browser glue for [`bragi-engine`](../bragi-engine): `wasm-bindgen` bindings and the AudioWorklet
host. Commands in and meters out travel over lock-free ring buffers in a `SharedArrayBuffer`, which
is why the web build requires cross-origin isolation
([01 §3](../../specs/01-architecture.md)).

**Status:** **built by WP-1.1.** `EngineWasm` exposes the handle API the AudioWorklet and the
decoder worker use: `add_asset` (symphonia), `load_project`, `transport`, `process`,
`render` (offline), `peaks`, `publish_state` and the counters. `scripts/build-engine-wasm.mjs`
emits the wasm-bindgen package into the gitignored `crates/bragi-engine-wasm/pkg/`, which
`pnpm test:conformance` renders through in Node and the web host loads at runtime.
