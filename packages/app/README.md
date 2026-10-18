# @bragi/app

The application: routes, features, views and panels. One bundle, loaded by
[`apps/web`](../../apps/web) in the browser and by [`apps/desktop`](../../apps/desktop) in the
Tauri webview.

| Path | What it is |
|---|---|
| `src/app/` | The router (code-based TanStack Router routes, hash history) and the shell |
| `src/features/projects/` | The project list, one project, and the repository that owns the `projects` table |
| `src/features/{universe,fuse}/` | Placeholder routes for later phases |
| `src/i18n/` | `en.json` — the source of truth for every user-facing string — and the typed `t()` |
| `src/lib/ulid.ts` | ULIDs for locally created ids (02 §2.1) |
| `src/mount.tsx` | `mountApp({ platform, container })`: the whole host-facing surface |

Conventions ([13 §3](../../specs/13-agent-guide.md)):

- Feature folders: `src/features/<feature>/{components,hooks,state,api,__tests__}`.
- React 19 function components and hooks; no class components.
- TanStack Router for routes (zoom level and selection live in the URL); Zustand for ephemeral UI
  state; the **Song Store** for the song document — which is only ever changed by applying op
  batches through `bragi-model` ([01 §5](../../specs/01-architecture.md)).
- No hard-coded user-facing strings: they come from `src/i18n/en.json` and follow the language
  guide ([11 §2](../../specs/11-ux-and-accessibility.md)).
- **Platform-agnostic.** No `@tauri-apps/*` imports and no adapter imports — those belong in
  [`@bragi/platform`](../platform). Enforced by Biome's `noRestrictedImports` and by
  `src/__tests__/boundaries.test.ts`.

**Status:** the four routes from WP-0.5 (`/`, `/song/:id`, `/universe`, `/fuse`) and the local
project list/detail flow. The Song Canvas, the Universe and the Fusion desk arrive with WP-1.9,
WP-3.3 and WP-5.1.
