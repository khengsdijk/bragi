# packages/model-wasm

The `wasm-bindgen` package wrapping [`crates/bragi-model`](../../crates/bragi-model). It exposes
handle-based APIs so the UI can apply op batches, validate, diff and query song documents without
copying whole documents across the WASM boundary (`specs/02-song-model.md` §8).

**Status:** built by **WP-0.3**. Everything in this directory except this README is **generated
output**, written by [`scripts/build-model-wasm.mjs`](../../scripts/build-model-wasm.mjs) and never
hand-edited ([13 §1](../../specs/13-agent-guide.md)):

```
pnpm build:model-wasm
```

It runs `cargo build --target wasm32-unknown-unknown -p bragi-model-wasm --release`, then
`wasm-bindgen --target web --out-dir packages/model-wasm`, writes `package.json`, and fails if the
gzipped `.wasm` exceeds the 1.5 MB budget. It needs `wasm-bindgen` **0.2.129** on PATH (the version
pinned in the root `Cargo.toml`):

```
cargo install wasm-bindgen-cli --version 0.2.129
```

`pnpm verify` runs it right after `pnpm build:wasm`.

## The handle API

```js
import init, { loadProject, assetAdd, validateDoc, applyBatch, sectionSpans, freeDoc } from "@bragi/model-wasm";

await init(); // `--target web`; pass { module_or_path } to control where the wasm comes from

const handle = loadProject(projectJson);   // JS reads the document once
assetAdd(handle, assetMetasJson);          // AssetMeta[] the invariants need
if (validateDoc(handle) !== undefined) throw new Error(validateDoc(handle));

applyBatch(handle, batchJson);             // mutates the stored document, returns its new JSON
const spans = sectionSpans(handle);        // hot path: no re-serialisation of the document
freeDoc(handle);
```

`applyBatch` throws with a JSON array of `{ opIndex, code, message }` when the batch is rejected
(`specs/02-song-model.md` §4.3); the stored document is unchanged.

## Budgets (from [12](../../specs/12-roadmap.md) WP-0.3)

| Budget | Measured (macOS 15 / arm64, 2026-10-19) |
|---|---|
| Bundle < 1.5 MB gzipped | **0.426 MiB gzipped** (1.525 MiB raw) |
| `apply` of a 50-op batch on a 10-minute document < 5 ms in WASM | **1.5 ms** |

Both are enforced by `scripts/build-model-wasm.mjs` and
[`scripts/__tests__/model-wasm.test.mjs`](../../scripts/__tests__/model-wasm.test.mjs).
