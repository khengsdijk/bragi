# 13 — Agent Implementation Guide

Status: Draft v0.3

This guide is for coding agents (and humans) implementing Bragi. Read it fully before starting any work package.

## 1. Golden rules

1. **The specs are the source of truth.** If code and spec disagree, the spec wins, or you change the spec in the same PR (§7). Never silently diverge.
2. **One work package at a time.** Pick it from [12-roadmap.md](12-roadmap.md), read every spec it lists, and stay within its scope. Note out-of-scope discoveries in [15-open-questions.md](15-open-questions.md) instead of implementing them.
3. **Contracts first.** If your WP needs a new field, op, job capability or endpoint, change the **JSON Schema** in `packages/schemas` first, regenerate (`pnpm schemas:gen`), and then implement. Never hand-edit generated code (it lives in `**/generated/**` directories with a header comment).
4. **The document is only changed by `bragi-model`.** TS code never mutates a song document directly. It builds op batches.
5. **The audio thread is sacred.** No allocation, locks, I/O, logging or panics in `process()` paths. Use the provided lock-free primitives.
6. **No new frameworks, languages or major dependencies without an ADR** in `specs/decisions/` (template in §8).
7. **No secrets, no copyrighted audio in the repo.** Fixtures must be self-made or generated; note the source of each fixture.
8. **Respect the content policy** ([10 §7](10-fusion.md)) in any AI-facing code.
9. **Platform-agnostic UI.** Anything that differs between web and desktop goes behind an interface in `packages/platform`. `packages/app` must not import `@tauri-apps/*`.

## 2. Workflow per work package

1. Create a branch: `wp/<id>-<slug>`, e.g. `wp/1.9-song-canvas-renderer`.
2. Write a short implementation plan as the first commit, in `docs/wp/<id>.md`: approach, files to touch, test plan, and any spec gaps found.
3. Implement in small commits. Keep tests green at each commit when practical.
4. Make every acceptance criterion executable where possible (automated test, benchmark script or eval report). For criteria that need human listening, add a `MANUAL_CHECKS.md` entry in the PR describing exactly what to listen for.
5. Update the WP status table in [12 §8](12-roadmap.md).
6. Open a PR using the template (§5).

## 3. Conventions

### TypeScript
- `strict: true`, no `any` (use `unknown` + narrowing), ES modules, Biome for lint/format.
- React: function components, hooks, no class components. Feature folders: `packages/app/src/features/<feature>/{components,hooks,state,api,__tests__}`.
- State: Zustand stores per feature for UI state. Song document state only via the Song Store wrapper around `model-wasm`.
- Async: TanStack Query for server data. WebSocket events go through a single `realtime` client that updates Query caches and the Song Store.
- Renderers (`render-canvas`, `render-universe`) are framework-agnostic classes. React mounts them and passes data, and they never import React.

### Rust
- Edition 2021+, `clippy -D warnings`, `rustfmt`. Library crates must compile for `wasm32-unknown-unknown` unless they are explicitly native-only (`*-native`).
- Errors: `thiserror` in libraries, no `unwrap()` outside tests (except proven-infallible cases with a comment).
- Snapshot tests with `insta`, property tests with `proptest`.
- Public functions in `bragi-model` and `bragi-engine` have doc comments with an example.

### Python
- 3.12, `uv`, `ruff` + `mypy --strict` for `bragi_common` (models may be looser), pydantic v2.
- Each worker capability is a module exposing `CAPABILITY`, `ParamsModel`, and `run(job, ctx) -> Outputs`. The framework handles everything else.
- GPU code must also run on CPU (slowly) so CI can run tiny smoke tests.
- Model weights are pinned by hash in `MODELS.md` and downloaded at image build.

### General
- IDs, times and units exactly as in [02 §2](02-song-model.md) (ticks i64, PPQ 960, 48 kHz). Variable names carry units when ambiguous: `lengthTicks`, `startSec`, `gainDb`, `cutoffHz`.
- Logging: structured, no audio content, lyrics or prompts at info level.
- User-facing strings come from `packages/app/src/i18n/en.json` (English only in v1, but no hard-coded strings) and follow the language guide ([11 §2](11-ux-and-accessibility.md)).

## 4. Definition of Done

A WP is Done when:
- [ ] All acceptance criteria in [12](12-roadmap.md) pass (automated where possible, manual checks documented).
- [ ] Unit tests cover new logic. Integration/e2e tests cover new user flows.
- [ ] `pnpm verify` is green, and `pnpm infra:up` reaches healthy if the WP touches infrastructure (§6).
- [ ] Performance budgets from the relevant spec are measured and recorded in the PR.
- [ ] New UI passes axe with no serious or critical issues, is keyboard reachable, and is reflected in the accessible DOM where it lives on a canvas.
- [ ] Schemas, generated code and docs are updated. Any spec deviations are reflected in the specs.
- [ ] `MODELS.md` is updated if models changed.
- [ ] WP status updated.

## 5. PR template

```markdown
## WP-<id>: <title>
### What
### How (key design choices, deviations from spec + spec updates)
### Acceptance criteria
- [ ] … (link to test / report)
### Performance (budget vs measured)
### Manual checks (if any)
### Screenshots / audio examples
```

## 6. Testing and verification

**Verification is local.** Bragi is a solo project, so the gate is `pnpm verify` on the
development machine — Biome + the layout guard, the TypeScript build, typecheck and unit tests,
rustfmt + clippy + `cargo test` + the wasm32 build, and ruff + `mypy --strict` + pytest — plus
`pnpm infra:up` when a WP touches infrastructure. A GitHub Actions workflow mirroring `pnpm verify`
across the three OSes is committed at `.github/workflows/ci.yml` and kept correct, but it is **not**
required to pass and has not been run (owner's decision, 2026-10-18).

The consequence to keep in mind: the "Runs on" column below says where a layer *must work*, not
where it is automatically exercised. Anything cross-platform — the engine on three OSes, WebKit
e2e, the Windows desktop build — is only as verified as the machines a WP is actually run on, and a
WP that cannot test a platform says so in its PR instead of implying coverage.

| Layer | Tooling | Must work on |
|---|---|---|
| Rust unit/snapshot/property | `cargo test`, `insta`, `proptest` | Linux, macOS, Windows |
| Engine conformance (WASM vs native null test) | custom harness (`pnpm test:conformance`) | Linux, macOS, Windows |
| TS unit | Vitest | Linux |
| Web e2e | Playwright: Chromium, Firefox, WebKit | Linux (+ WebKit on macOS) |
| Desktop e2e | The app's own `selftest` build driven in-page (WKWebView has no WebDriver, so `tauri-driver` cannot reach macOS); `tauri-driver` where it exists | macOS, Windows, Linux |
| Visual regression | Playwright screenshots with WebGPU on and off | Linux |
| Python | pytest (CPU smoke with tiny inputs) | Linux |
| Integration | docker compose stack + API/worker tests | Linux |
| Analysis eval | `pnpm eval:analysis` (GPU, on demand / nightly) | GPU runner |
| Planner bench | `pnpm bench:planner` (weekly, costs API credits) | Linux |

**Fixtures:**
- `fixtures/audio/`: tiny clips (≤ 30 s, ≤ 5 MB total in git), self-made, each with a `SOURCE.txt` entry.
- `fixtures/projects/`: song documents for model/engine tests.
- `fixtures/eval/manifest.json`: the larger eval set referenced by hash. Audio is stored in a private bucket and fetched by `scripts/fetch-eval.sh` (requires credentials). It is never committed.

## 7. Changing the specs

- Small clarifications: edit the spec in your WP's PR and mention it under "How".
- Behaviour or contract changes: edit the spec + schema in a separate commit titled `spec: …`.
- Decisions with trade-offs (library choice, architecture shift): add an ADR, then update the specs to reference it.
- Every spec file has a `Status:` line. Bump the draft version (v0.1 → v0.2) on substantive changes.
- Unresolved questions go in [15-open-questions.md](15-open-questions.md) with an owner and the WP that needs the answer.

## 8. ADR template

```markdown
# ADR-NNNN — <title>
- **Status:** Proposed | Accepted | Superseded by ADR-XXXX
- **Date:** YYYY-MM-DD
## Context
## Options considered (table with pros/cons)
## Decision
## Consequences (positive, negative, mitigations)
```

## 9. Commands

Created in WP-0.1. A command whose owning work package has not landed yet exists but fails,
naming that work package, so the surface is discoverable without pretending to work. From WP-0.5
on, `dev:web`, `dev:desktop`, `test:e2e` and `test:e2e:desktop` are real; what has actually been
run on which platform is recorded per work package (see [12 §8](12-roadmap.md) and the work
package's plan in `docs/wp/`).

| Command | Does |
|---|---|
| `pnpm verify` | **The gate** (§4, §6): lint + generated-code check + build + typecheck + test, all three languages |
| `pnpm lint` / `pnpm lint:rust` / `pnpm lint:py` / `pnpm lint:all` | Biome + the 01 §4 layout guard / rustfmt + clippy / ruff + mypy / all three |
| `pnpm test:rust` / `pnpm test:py` / `pnpm test:all` | `cargo test` / pytest / plus `pnpm test` |
| `pnpm build:wasm` | `wasm32-unknown-unknown` build of every non-native crate |
| `pnpm infra:up` / `infra:logs` / `infra:down` | Local infrastructure (Postgres+pgvector, MinIO, NATS, Mailpit) |
| `pnpm dev:web` | Builds the workspace packages the web app consumes (`@bragi/app`, `@bragi/platform`, …; turbo-cached), then the Vite dev server with COOP/COEP. Edits to those packages need a restart (or `pnpm build`) — Vite serves their `dist` |
| `pnpm dev:desktop` | Tauri dev |
| `pnpm dev:backend` | `scripts/dev-backend.mjs`: ensures the docker compose infra is up, then runs the API, the orchestrator and the Python analysis worker (all capabilities) as local processes with prefixed logs; Ctrl-C stops them. Defaults to single-user mode (`BRAGI_AUTH_MODE=single-user`, `API_HOST=127.0.0.1`; [ADR-0014](decisions/ADR-0014-single-user-mode.md)), so the app needs no sign-in. Separation weights: see the script header (`.bragi/models`, gitignored) |
| `pnpm schemas:gen` | Regenerate TS/Rust/Python from JSON Schemas |
| `pnpm schemas:check` | Fail if the generated code does not match the JSON Schemas (runs first in `pnpm verify`) |
| `pnpm test` | TypeScript unit tests (`test:all` adds Rust and Python) |
| `pnpm test:e2e` | Playwright web e2e: Chromium, Firefox and Playwright WebKit, each against the dev server and a production preview |
| `pnpm test:e2e:flow` | The WP-1.10 upload flow in Chromium against the **live local stack** (`apps/web/e2e/upload-flow.spec.ts`): needs `pnpm infra:up` and `pnpm dev:backend` (API 8080, separation weights in `.bragi/models`) on the single-user stack (the `dev:backend` default) and sets `BRAGI_E2E_STACK=1`. Without that variable the spec is skipped with a message, so `pnpm test:e2e` stays green with no stack. Rebuild `@bragi/app`/`@bragi/platform` (`pnpm build`) first: the web app consumes their `dist`. `BRAGI_E2E_WARM=1` keeps the fixture's earlier analysis (cached run); the default clears it for cold timings. Other browsers: `BRAGI_E2E_STACK=1 pnpm --filter @bragi/web exec playwright test upload-flow --project=firefox-dev` (or `webkit-dev`) |
| `pnpm test:e2e:desktop` | Tauri desktop e2e: builds the app with `--features selftest` and drives the shipped bundle in the webview through two process launches |
| `pnpm test:integration` | docker compose stack + the WP-0.7 acceptance test (API → NATS → worker → WebSocket + trace) |
| `pnpm test:conformance` | Engine WASM vs native parity |
| `pnpm eval:analysis` / `pnpm bench:planner` | Quality evaluations. `eval:analysis` (WP-1.2) runs the harness and writes `reports/analysis-<date>.md`; `eval:analysis:ml` does the same with the `ml` extra (Beat This!) |
