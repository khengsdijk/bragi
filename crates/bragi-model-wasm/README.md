# crates/bragi-model-wasm

The `wasm-bindgen` bindings for [`bragi-model`](../bragi-model): the handle-based API the UI calls
(`specs/02-song-model.md` §8). A document crosses the WASM boundary once as JSON; later calls pass
an integer handle, so `sectionSpans` and `ticksToSeconds` never re-serialise it.

It is deliberately separate from `bragi-model`, which stays a pure, `#![forbid(unsafe_code)]`,
WASM-agnostic library (the same shape as `bragi-engine-wasm`).

The generated npm package lives in [`packages/model-wasm`](../../packages/model-wasm) and is built
by [`scripts/build-model-wasm.mjs`](../../scripts/build-model-wasm.mjs) (`pnpm build:model-wasm`).
Crate type is `cdylib` (for `wasm-bindgen`) plus `rlib` (so `cargo test --workspace` and
`cargo clippy --workspace` build and lint it natively too).
