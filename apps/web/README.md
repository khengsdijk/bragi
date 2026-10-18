# apps/web

Vite entry point for the browser build: `index.html`, the COOP/COEP header configuration
(required for `SharedArrayBuffer`, see [01 §3](../../specs/01-architecture.md)), and the
service worker. It renders [`@bragi/app`](../../packages/app) and nothing else.

**Status:** placeholder. Created by **WP-0.5** (platform shell), which must also prove
`crossOriginIsolated === true` in Chromium, Firefox and Safari.

Build and distribution notes: [01 §9](../../specs/01-architecture.md).
