# apps/desktop

The Tauri 2 desktop app. It loads the same [`@bragi/app`](../../packages/app) bundle as the web
build into the system webview; everything platform-specific sits behind the interfaces in
[`@bragi/platform`](../../packages/platform).

| Path | What it is |
|---|---|
| [`src-tauri/`](src-tauri) | Rust side: commands, native engine host, rusqlite, filesystem blob cache, deep links, updater |

**Status:** placeholder. Created by **WP-0.5**; signing, notarisation and auto-update land in
**WP-6.1**.

Specs: [01 §3](../../specs/01-architecture.md) (web vs desktop),
[01 §9](../../specs/01-architecture.md) (distribution),
[01 §10](../../specs/01-architecture.md) (Tauri capability allow-listing).
