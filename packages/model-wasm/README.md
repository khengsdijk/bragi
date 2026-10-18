# packages/model-wasm

The `wasm-bindgen` package wrapping [`crates/bragi-model`](../../crates/bragi-model). It exposes
handle-based APIs so the UI can apply op batches, validate, diff and query song documents without
copying whole documents across the WASM boundary.

**Status:** placeholder. This package is **generated** output — it is created by **WP-0.3** and
must never be hand-edited ([13 §1](../../specs/13-agent-guide.md)). It therefore has no
`package.json` yet and is not a pnpm workspace member.

Budget from [12](../../specs/12-roadmap.md): bundle < 1.5 MB gzipped; `apply` of a 50-op batch on a
10-minute document < 5 ms.
