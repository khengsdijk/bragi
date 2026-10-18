# apps/desktop/src-tauri

The Tauri Rust process. It hosts:

- `bragi-engine-native` with cpal audio output,
- `rusqlite` for the local database and the filesystem blob cache,
- the library folder watcher, `bragi://` deep links, OS media keys and the updater.

Tauri 2 permissions are allow-listed per command — the webview gets no blanket filesystem
access ([01 §10](../../../specs/01-architecture.md)).

**Status:** placeholder. Created by **WP-0.5**.
