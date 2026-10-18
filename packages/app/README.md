# @bragi/app

The application: routes, features, views and panels. One bundle, loaded by
[`apps/web`](../../apps/web) in the browser and by [`apps/desktop`](../../apps/desktop) in the
Tauri webview.

Conventions ([13 §3](../../specs/13-agent-guide.md)):

- Feature folders: `src/features/<feature>/{components,hooks,state,api,__tests__}`.
- React 19 function components and hooks; no class components.
- TanStack Router for routes (zoom level and selection live in the URL); Zustand for ephemeral UI
  state; the **Song Store** for the song document — which is only ever changed by applying op
  batches through `bragi-model` ([01 §5](../../specs/01-architecture.md)).
- No hard-coded user-facing strings: they come from `src/i18n/en.json` and follow the language
  guide ([11 §2](../../specs/11-ux-and-accessibility.md)).
- **Platform-agnostic.** No `@tauri-apps/*` imports — those belong in
  [`@bragi/platform`](../platform).

**Status:** scaffold only. The first routes (`/`, `/song/:id`, `/universe`, `/fuse`) arrive with
**WP-0.5**.
