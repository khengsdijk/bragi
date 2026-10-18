# apps/desktop

The Tauri 2 desktop app. It loads the same [`@bragi/app`](../../packages/app) bundle as the web
build into the system webview; everything platform-specific sits behind the interfaces in
[`@bragi/platform`](../../packages/platform).

| Path | What it is |
|---|---|
| [`src-tauri/`](src-tauri) | Rust side: Tauri commands, rusqlite, the filesystem blob cache, the `selftest` harness |
| [`scripts/selftest.mjs`](scripts/selftest.mjs) | `pnpm test:e2e:desktop`: builds the bundle + the app and runs the acceptance scenario in two process launches |
| [`scripts/make-icon.mjs`](scripts/make-icon.mjs) | Regenerates the (self-made) source icon that `tauri icon` expands |

`pnpm dev:desktop` runs `tauri dev`, which serves the frontend from `apps/web`'s dev server.
`pnpm test:e2e:desktop` runs the shipped bundle instead. What has actually been run, and on which
platform, is in [docs/wp/0.5.md](../../docs/wp/0.5.md).

**Status:** the platform shell (WP-0.5). Signing, notarisation and auto-update land in **WP-6.1**.

Specs: [01 §3](../../specs/01-architecture.md) (web vs desktop),
[01 §9](../../specs/01-architecture.md) (distribution),
[01 §10](../../specs/01-architecture.md) (Tauri capability allow-listing).
