# packages/

The TypeScript workspace. Platform-agnostic by default: anything that differs between web and
desktop goes behind an interface in [`platform/`](platform), and
[`app/`](app) must never import `@tauri-apps/*` ([13 §1](../specs/13-agent-guide.md)).

| Package | What it is | Filled by |
|---|---|---|
| [`app/`](app) | Routes, features, views, panels | WP-0.5 onwards |
| [`design/`](design) | Design tokens, Radix-based components, icons | WP-0.6 |
| [`render-canvas/`](render-canvas) | PixiJS renderers for the Song Canvas | WP-1.9 |
| [`render-universe/`](render-universe) | Three.js renderer for the library map | WP-3.3 |
| [`platform/`](platform) | EngineHost, LocalDB, BlobCache, FileAccess, Auth — interfaces + web/tauri implementations | WP-0.5 |
| [`model-wasm/`](model-wasm) | Generated wasm-bindgen wrapper around `crates/bragi-model` | WP-0.3 |
| [`schemas/`](schemas) | JSON Schemas (source of truth) + generated TS types and validators | WP-0.2 |
| [`api-client/`](api-client) | Typed client generated from the API's OpenAPI document | WP-0.7 |

Renderers are framework-agnostic classes: they never import React
([13 §3](../specs/13-agent-guide.md)).
