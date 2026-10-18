# 01 — System Architecture

Status: Draft v0.2 · Decision record: [ADR-0001](decisions/ADR-0001-tech-stack.md)

## 1. Stack at a glance

| Layer | Choice | Why |
|---|---|---|
| UI language | **TypeScript (strict)** | One language for web and desktop UI, shared types |
| UI framework | **React 19** + **Vite** | Largest ecosystem for complex editor UIs and the best agent familiarity |
| Routing | **TanStack Router** | Type-safe routes and search params (zoom level and selection live in the URL) |
| UI state | **Zustand** (ephemeral UI state) + the **Song Store** (see §5) | Simple and fast, no boilerplate |
| Server state | **TanStack Query** | Caching, retries, optimistic updates |
| Components | **Radix UI primitives** + own design tokens (CSS variables + CSS Modules) | Accessible primitives, full visual control |
| 2D canvas rendering | **PixiJS v8** (WebGPU renderer with automatic WebGL2 fallback) | GPU-accelerated 2D with a robust fallback for Linux WebKitGTK |
| 3D Universe rendering | **Three.js** `WebGPURenderer` (falls back to WebGL2) | Mature 3D, instancing for 100k+ points |
| Model logic | **Rust → WASM** (`bragi-model` crate, via `wasm-bindgen`) | *One* implementation of song-model operations, used by the UI everywhere and natively by the engine |
| Audio engine | **Rust** (`bragi-engine`): **native** on desktop (cpal), **WASM in an AudioWorklet** in the browser | Same DSP code everywhere, native latency on desktop |
| Audio decode | **symphonia** (Rust, native + WASM) | One decoder everywhere, deterministic results |
| Desktop shell | **Tauri 2** | Small binaries, Rust backend in-process, cross-platform bundling and updates |
| Local persistence | **SQLite** everywhere: `rusqlite` on desktop, official **sqlite-wasm on OPFS** in the browser | One schema and one migration set |
| Local blob cache | Desktop: app data directory · Browser: **OPFS** | Content-addressed audio and stem files |
| API service | **Node.js (current LTS) + Fastify + TypeScript** | Shares schemas with the UI. Fits the owner's TS background. |
| Auth | **Better Auth** (email magic link + Google/GitHub OAuth). Desktop uses PKCE through the system browser and a `bragi://` deep link. | Self-hosted, TS-native |
| Database | **PostgreSQL 17 + pgvector** | Relational data, op log and vector search in one place |
| Object storage | **S3** (AWS in prod, **MinIO** locally) | Content-addressed blobs |
| Event bus / jobs | **NATS JetStream** | Lightweight, durable streams, first-class TS and Python clients. Contracts are broker-agnostic so Kafka can replace it later. |
| ML workers | **Python 3.12**, **uv**, **PyTorch**, containerised | The model ecosystem lives in Python |
| LLM | **Anthropic Claude API** (model IDs in config) | Planner, descriptions, labelling |
| Schemas | **JSON Schema (2020-12)** as source of truth → codegen to TS, Rust (`typify`) and Python (Pydantic v2) | One contract across three languages |
| Monorepo | **pnpm workspaces + Turborepo**, **Cargo workspace**, **uv workspace** | Standard tools per language, one repo |
| Testing | Vitest, Playwright (web + Tauri via WebDriver), `cargo test` + `insta` snapshots, pytest | See [13-agent-guide.md](13-agent-guide.md) |
| Observability | OpenTelemetry (traces across API → NATS → workers), Sentry for client crashes | Debugging async pipelines |

> **Rule:** Agents must not introduce a new framework, language or major dependency without adding an ADR in `specs/decisions/`.

## 2. High-level component diagram

```
┌──────────────────────────────── CLIENT (same UI code on web & desktop) ────────────────────────────────┐
│                                                                                                         │
│  React App (packages/app)                                                                               │
│   ├─ Views: Universe (Three.js) · Song Canvas (PixiJS) · Moment (PixiJS) · Panels (React/Radix)         │
│   ├─ Song Store ──► bragi-model (WASM): apply ops, validate, diff, query                                │
│   ├─ Job Client  ──► API (HTTPS) + live updates (WebSocket)                                             │
│   └─ Platform Adapter (packages/platform)                                                               │
│        ├─ EngineHost  ── browser: WasmEngineHost (AudioWorklet + SharedArrayBuffer)                     │
│        │              └─ desktop: TauriEngineHost (IPC → native engine)                                 │
│        ├─ LocalDB     ── browser: sqlite-wasm/OPFS · desktop: Tauri cmd → rusqlite                      │
│        ├─ BlobCache   ── browser: OPFS · desktop: filesystem                                            │
│        └─ FileAccess  ── browser: File System Access API / <input> · desktop: native dialogs            │
│                                                                                                         │
│  Desktop only: Tauri Rust process (apps/desktop/src-tauri)                                              │
│   ├─ bragi-engine (native) + cpal audio output                                                          │
│   ├─ rusqlite, filesystem blob cache, library folder watcher                                            │
│   └─ deep links, auto-update, OS media keys                                                             │
└───────────────────────────────────────────────┬─────────────────────────────────────────────────────────┘
                                                │ HTTPS (REST + JSON) / WebSocket
┌───────────────────────────────────────────────▼───────────────── CLOUD ────────────────────────────────┐
│  API service (services/api, Fastify)                                                                    │
│   ├─ auth, projects, sync (commits), assets (presigned S3 URLs), jobs, search                           │
│   ├─ AI planner module (Claude API, tool use → EditPlan)                                                │
│   └─ WebSocket gateway (job progress, partial results)                                                  │
│            │ publish/consume                                │ SQL                │ S3                   │
│      ┌─────▼────────┐                               ┌───────▼──────┐     ┌───────▼──────┐               │
│      │ NATS JetStream│                              │ Postgres +    │     │ S3 / MinIO    │              │
│      │ (jobs, events)│                              │ pgvector      │     │ (blobs)       │              │
│      └─────┬────────┘                               └──────────────┘     └──────────────┘               │
│            │                                                                                            │
│  GPU/CPU workers (services/workers, Python)                                                             │
│   ├─ ingest (decode, normalise, fingerprint)   ├─ separate (stems)     ├─ rhythm (beats, tempo)         │
│   ├─ harmony (key, chords)  ├─ structure (sections)  ├─ embed (audio/text embeddings)  ├─ tag/describe  │
│   ├─ generate (extend, inpaint, stem-gen, text-to-music, fx)  ├─ transform (timbre swap, style)          │
│   └─ project (library map projection, constellations)                                                   │
└─────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## 3. Web vs desktop: what differs and what doesn't

The core rule: **the React app does not know which platform it runs on.** All differences live behind interfaces in `packages/platform`.

| Concern | Browser | Desktop (Tauri) |
|---|---|---|
| UI | Same `packages/app` bundle | Same bundle, loaded into the system webview |
| Model ops | `bragi-model` WASM | `bragi-model` WASM (also in the webview, so the code path is identical) |
| Audio playback | `bragi-engine` compiled to WASM, running inside an **AudioWorklet**. Commands and meters go over SharedArrayBuffer ring buffers. | `bragi-engine` **native** in the Tauri process, output via **cpal** (CoreAudio / WASAPI / ALSA-PulseAudio-PipeWire) |
| Offline render / export | WASM in a dedicated Web Worker | Native, multithreaded |
| Local DB | sqlite-wasm on OPFS (in a Worker) | rusqlite via Tauri commands |
| Blob cache | OPFS, subject to browser quota | Filesystem, no practical limit |
| Library import | Drag-and-drop or folder pick (File System Access API on Chromium, file input elsewhere) | Native folder pick + **watched library folders** |
| Auth | Cookie session | PKCE in the system browser → `bragi://auth/callback` → token stored in the OS keychain (Tauri `stronghold` or `keyring` crate) |
| Offline | Editing works offline once assets are cached. AI requires network. | Same, plus full library available offline |
| Required headers | `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (needed for SharedArrayBuffer) | n/a |

**Why native audio on desktop** (instead of WASM in the webview): lower and more stable latency, no background-tab throttling, no WebKitGTK AudioWorklet quirks on Linux, multithreaded rendering, and the ability to memory-map large files.

**Platform risk:** the webviews differ (WKWebView on macOS, WebView2/Chromium on Windows, WebKitGTK on Linux). WebGPU availability varies, especially on Linux. Every renderer **must** work on the WebGL2 fallback. The CI matrix runs the e2e suite on all three desktop OSes plus Chromium, Firefox and Safari ([13-agent-guide.md §6](13-agent-guide.md)).

## 4. Repository layout

```
bragi/
├─ apps/
│  ├─ web/                    # Vite entry for the browser build (index.html, headers config, service worker)
│  └─ desktop/                # Tauri 2 app
│     ├─ src-tauri/           # Rust: commands, native engine host, db, fs, deep links, updater
│     └─ (loads packages/app)
├─ packages/
│  ├─ app/                    # The application: routes, features, views, panels (platform-agnostic)
│  ├─ design/                 # Design tokens, Radix-based components, icons
│  ├─ render-canvas/          # PixiJS renderers: section blocks, ribbons, skyline, harmony strip, moment view
│  ├─ render-universe/        # Three.js renderer for the library map
│  ├─ platform/               # Interfaces + web and tauri implementations (EngineHost, LocalDB, BlobCache, FileAccess, Auth)
│  ├─ model-wasm/             # Generated wasm-bindgen package wrapping crates/bragi-model
│  ├─ schemas/                # JSON Schemas (source of truth) + generated TS types + validators
│  └─ api-client/             # Typed client for services/api (generated from OpenAPI)
├─ crates/
│  ├─ bragi-model/            # Song model types, op application, validation, diff, time mapping
│  ├─ bragi-dsp/              # DSP primitives: stretch, pitch, filters, dynamics, reverb, loudness, crossfades
│  ├─ bragi-engine/           # Audio graph, scheduler, renderer, playback state machine (platform-free)
│  ├─ bragi-engine-wasm/      # wasm-bindgen + AudioWorklet glue
│  └─ bragi-engine-native/    # cpal output, mmap file reading, thread pool
├─ services/
│  ├─ api/                    # Fastify API, auth, sync, planner module, WebSocket gateway
│  └─ workers/                # uv workspace
│     ├─ bragi_common/        # NATS client, job protocol, S3 helpers, generated Pydantic models
│     ├─ analysis/            # ingest, separate, rhythm, harmony, structure, tag/describe
│     ├─ embed/               # audio/text embeddings, projection, constellations
│     └─ generate/            # extend, inpaint, stem-gen, text-to-music, fx, transform
├─ infra/
│  ├─ docker-compose.yml      # postgres, minio, nats, api, workers (CPU), mailpit
│  └─ deploy/                 # IaC (added in Phase 3+)
├─ fixtures/                  # Small, license-clean audio fixtures + golden analysis outputs
└─ specs/                     # These documents
```

## 5. The Song Store (client state architecture)

The **song document** (see [02-song-model.md](02-song-model.md)) is the single source of truth for a project.

```
User gesture ──► Interaction layer (transient preview state, TS, 60 fps)
                        │ on commit (mouse-up, Enter, accept candidate)
                        ▼
                 Op batch (typed edit operations)
                        │
                        ▼
        bragi-model WASM: validate + apply → new immutable document + commit
                        │
          ┌─────────────┼───────────────┬─────────────────┐
          ▼             ▼               ▼                 ▼
     React views   EngineHost.load   LocalDB.save     SyncQueue (to API)
     (re-render)   (diff → engine)   (commit)         (when online)
```

Rules:
- **Drags never mutate the document.** During a drag the interaction layer renders a *preview* (and for audio, sends lightweight engine preview commands such as moving a clip's playback offset). The op batch is created **only on commit**.
- **The engine receives diffs**, not whole documents: `bragi-model` exposes `diff(prev, next) -> EngineDelta`.
- Ops are applied **only through `bragi-model`**. The TS code never hand-edits a document object.

## 6. Data flow: upload to playable song

1. The user drops `song.mp3`. The client computes **SHA-256** and checks the BlobCache and API (`HEAD /assets/{hash}`). If the hash is known, the upload is skipped.
2. The client creates a **Project** locally with a `Source` pointing at the asset hash. It is playable immediately (the original stereo file).
3. The client uploads via presigned S3 URL, then `POST /analyses {assetHash, profile:"standard"}`.
4. The API publishes `job.requested` events for the analysis DAG ([04-analysis-pipeline.md §2](04-analysis-pipeline.md)).
5. Workers emit `analysis.partial` events as each stage completes. The API pushes these to the client over WebSocket.
6. The client merges each partial result into the document as an **`analysis.apply` op batch** authored by `system`. The canvas progressively gains a beat grid, sections, stems, chords, tags and a description.
7. Stems are downloaded lazily into the BlobCache. Ribbons become soloable as each stem arrives.

## 7. Cross-language contracts

| Contract | Defined in | Consumers |
|---|---|---|
| Song document + ops | `packages/schemas/song/*.schema.json` | TS (UI), Rust (`bragi-model`, `bragi-engine`), Python (workers read context) |
| Analysis results | `packages/schemas/analysis/*.schema.json` | Python (producer), TS/Rust (consumer) |
| Job & event envelopes | `packages/schemas/jobs/*.schema.json` | API, workers |
| API error code registry | `packages/schemas/api/errors.json` + `error.schema.json` | API (`services/api`), `packages/api-client`, TS/Python/Pydantic clients |
| REST API | OpenAPI 3.1 generated from Fastify route schemas | `packages/api-client` |
| Engine commands | Rust enum in `bragi-engine`, exported via `ts-rs` | `packages/platform` |

**Versioning rule.** A **document or envelope that travels on its own** carries `schemaVersion` (currently `1`): the project document, every analysis result blob, and the job request and event envelopes. **Ops, op batches and commits do not**: they only ever exist as part of a document's history, so they inherit the project's version, and a new op is an additive change to the op catalogue ([02 §4.2](02-song-model.md)) rather than a new version number. Breaking changes require a migration in `bragi-model` (`migrate(doc) -> doc`) and an ADR.

## 8. Environments

| Env | Purpose | Notes |
|---|---|---|
| `local` | Developer machine | `docker compose up` runs postgres, minio, nats, api and CPU workers. GPU workers optional (CUDA or Apple MPS where supported) or pointed at a remote GPU pool. |
| `staging` | Integration | Small GPU pool, test accounts |
| `prod` | Users | Autoscaled GPU pool ([05-backend-and-jobs.md §9](05-backend-and-jobs.md)) |

Configuration comes from environment variables, validated at boot with zod (API) and pydantic-settings (workers). No secrets are allowed in the repo.

## 9. Build and distribution

- **Web:** static SPA built by Vite and served from a CDN with COOP/COEP headers. The WASM files are served with `application/wasm` and long-cache immutable hashes.
- **Desktop:** Tauri bundler produces macOS `.dmg` (signed and notarised, universal binary), Windows `.msi`/NSIS (code-signed), and Linux `.AppImage` + `.deb` + `.rpm`. The **Tauri updater** plugin uses a signed update manifest.
- **Release cadence:** web and desktop share a version number (`MAJOR.MINOR.PATCH`). The desktop app checks API compatibility via `GET /meta` (`minClientVersion`).

## 10. Security baseline

- All asset access uses short-lived presigned URLs scoped to the user.
- Uploaded audio is decoded **only** by symphonia/ffmpeg inside sandboxed workers. The API never parses audio.
- Tauri capabilities are allow-listed per command (Tauri 2 permissions). The webview gets no blanket filesystem access.
- Strict CSP in both builds. No remote script loading.
- LLM inputs that include user text are treated as untrusted. The planner may only emit schema-validated ops ([06-ai-planner.md §7](06-ai-planner.md)).
