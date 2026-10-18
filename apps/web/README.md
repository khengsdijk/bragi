# apps/web

Vite entry point for the browser build, and the **only** bundle: `apps/desktop` embeds
`apps/web/dist` verbatim, so "the same app on web and desktop" is literally the same files
([01 §3](../../specs/01-architecture.md)).

| Path | What it is |
|---|---|
| [`index.html`](index.html) | The document; a single `#root` and the module entry |
| [`src/main.tsx`](src/main.tsx) | Builds the `Platform` with `@bragi/platform/auto` and mounts `@bragi/app` |
| [`src/headers.ts`](src/headers.ts) | COOP/COEP + CSP, sent by the dev server *and* the preview server; unit-tested |
| [`src/migrations.ts`](src/migrations.ts) | Bundles `packages/schemas/sqlite/migrations` into the page, byte-for-byte |
| [`e2e/`](e2e) | The WP-0.5 acceptance scenario, its two drivers and the Playwright config |
| [`../desktop/src-tauri/`](../desktop/src-tauri) | The other host of this bundle |

`pnpm dev:web` serves it with `crossOriginIsolated === true` (required for `SharedArrayBuffer` and
sqlite-wasm). `pnpm test:e2e` runs the web e2e in Chromium, Firefox and Playwright WebKit, against
both the dev server and `vite preview` of the production build.

**Status:** the platform shell (WP-0.5). The service worker and the production CDN headers arrive
with the deploy work package (01 §9); the design system with WP-0.6.
