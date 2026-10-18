# @bragi/platform

The platform seam ([01 §3](../../specs/01-architecture.md)). `packages/app` is written against the
interfaces here and never learns which host it is on.

| Entry point | What it is |
|---|---|
| `@bragi/platform` | The interfaces (`LocalDB`, `BlobCache`, `FileAccess`, `Platform`), the shared migration runner, blob hashing, in-memory adapters. Safe to import anywhere. |
| `@bragi/platform/auto` | Picks the adapter set for the host at runtime; each set is a separate lazy chunk. |
| `@bragi/platform/web` | sqlite-wasm on OPFS + OPFS blobs, in a dedicated worker (`src/web/storage.worker.ts`). |
| `@bragi/platform/tauri` | `rusqlite` and the filesystem blob cache through Tauri commands. The only module that imports `@tauri-apps/*`. |
| `@bragi/platform/testing` | `node:sqlite` + `Map` doubles, Node-only. |

Every implementation that can run under Node passes the same contract suite
(`src/__tests__/contract/`): the `node:sqlite` fake, the sqlite-wasm engine, the worker protocol
over a real `MessageChannel`, and the Tauri adapters over an IPC double. OPFS itself only exists in
browsers, so the shipped web adapters are exercised by `pnpm test:e2e` and the Tauri ones by
`pnpm test:e2e:desktop` — plus `cargo test` in `apps/desktop/src-tauri` for the Rust half.

The migration SQL lives in [`packages/schemas/sqlite/migrations`](../schemas/sqlite/migrations)
(WP-0.5 owns that directory) and is applied by one runner on both hosts, so the browser and the
desktop cannot disagree about the schema.

**Status:** LocalDB, BlobCache, FileAccess and migrations (WP-0.5). `EngineHost` and `Auth` arrive
with [03](../../specs/03-audio-engine.md) (WP-1.1) and [05 §8](../../specs/05-backend-and-jobs.md)
(WP-2.9).
