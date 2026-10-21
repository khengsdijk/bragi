# 05 — Backend, Jobs & Sync

Status: Draft v0.5 · Code: `services/api`, `services/workers` · Infra: `infra/`

## 1. Services

| Service | Language | Process(es) | Responsibility |
|---|---|---|---|
| `api` | TypeScript (Fastify) | `api-http` | REST + WebSocket, auth, projects/sync, assets, search, planner endpoint |
| | | `api-orchestrator` | Same codebase, separate entrypoint. Consumes job events, schedules dependent DAG stages, writes job state to Postgres, fans events out to WebSocket via NATS. |
| `workers/analysis` | Python | one process per stage type (scalable independently) | Analysis stages ([04](04-analysis-pipeline.md)) |
| `workers/embed` | Python | `embed`, `project` | Embeddings, map projection, constellations ([08](08-universe.md)) |
| `workers/generate` | Python | one process per generation capability | Generation and transform ([09](09-generation.md), [10](10-fusion.md)) |
| Postgres + pgvector | — | — | Relational state, op log, vectors |
| NATS JetStream | — | — | Job queues and events |
| S3 / MinIO | — | — | Content-addressed blobs |

## 2. REST API (v1)

All endpoints are under `/v1`, JSON, and authenticated (session cookie on web, bearer token on desktop; in single-user mode every request resolves to the owner, §8). Route schemas are defined with TypeBox/zod and exported to OpenAPI 3.1 → `packages/api-client`.

| Method & path | Purpose |
|---|---|
| `GET /meta` | `{ apiVersion, minClientVersion, features }` |
| `/auth/*` | Better Auth routes (magic link, OAuth, session, desktop PKCE) |
| `GET /auth/mode` | `{ mode: "single-user" \| "multi-user", user }` (`AuthModeResponse`, §8); `user` is `null` when signed out in multi-user mode |
| `POST /assets/presign` | `{ hash, bytes, mime }` → `{ exists: true }` or `{ uploadUrl, headers }` (presigned PUT, 15 min) |
| `POST /assets/{hash}/complete` | Server verifies size + hash (S3 checksum), records ownership in `user_assets` |
| `GET /assets/{hash}/url` | Presigned GET (1 h) if the user owns or derived the asset |
| `GET /library` | Paged library items with summaries |
| `POST /library/import` | `{ items: [{ assetHash, filename, title?, artist?, album? }] }` → creates library items and enqueues `quick` analysis |
| `PATCH /library/{id}` / `DELETE /library/{id}` | Edit metadata / remove from library (assets GC'd if unreferenced) |
| `POST /analyses` | `{ assetHash, profile }` → `{ stages: [{ stage, status, blob? }] }` (cached stages return immediately) |
| `GET /analyses/{assetHash}` | Current stage statuses + blob refs |
| `GET /projects` / `POST /projects` | List / create (client-generated IDs accepted) |
| `GET /projects/{id}` | Metadata + refs |
| `DELETE /projects/{id}` | Soft delete (30-day recovery) |
| `GET /projects/{id}/commits?since={cursor}` | Commits after cursor (sync pull) |
| `POST /projects/{id}/commits` | Push commits (sync push). Snapshots uploaded as assets first. |
| `PUT /projects/{id}/refs` | Compare-and-swap ref update: `{ expected, next }` |
| `POST /plans` | Planner: `{ projectId, commitId, region?, prompt, uiContext }` → `EditPlan` ([06](06-ai-planner.md)). A plan with variants is stored (`plans`, §5) so it can be executed by id. |
| `POST /plans/{id}/execute` | Runs the chosen variants' `generate` steps as interactive jobs ([06 §5](06-ai-planner.md)): body `{ variants?: number[], contexts: { <stepId>: { context?, before?, after? } } }` (the rendered context assets), answer `{ jobs: [{ variant, stepId, jobId, capability, status, estimatedCredits }] }`. 400 for a bad index or missing context asset, 404 for an unknown/expired plan or an unowned asset, 402/503 as for a job submit. |
| `POST /jobs` | Direct job submission for UI actions that skip the planner (e.g. "Extend 16 bars"). The params are validated against the capability's schema (`generate.extend` has one; analysis capabilities keep the worker-side check), generation inputs must be assets the user owns, and generation submits also check credits and the GPU budget (§9). |
| `GET /jobs/{id}` / `DELETE /jobs/{id}` | Status (including `paused`, §9) / cancel |
| `POST /generations/warmup` | `→ 202 { status: "warming" \| "warm" \| "disabled" }`: the cheap model load of 09 §5. Idempotent; `disabled` when no generation worker runs against this environment. |
| `POST /search` | `{ query: { text } \| { audioAsset } \| { hum: assetHash }, scope: "song"\|"section"\|"stem", k, filters }` |
| `GET /universe/layout?lens=` | Current 2D/3D layout for a lens ([08](08-universe.md)) |
| `GET /universe/constellations?type=` | Relationship edges |
| `POST /universe/path` | `{ from, to, mode: "playlist"\|"generate", steps }` |
| `GET /usage` | Credits used/remaining |

Error format: `{ error: { code: "QUOTA_EXCEEDED", message, details? } }`. Codes are stable and listed in `packages/schemas/api/errors.json`. A generation submit that fails its params is `400 VALIDATION_FAILED` (the message names the field), an unaffordable one is `402 INSUFFICIENT_CREDITS` (`details: { required, used, allowance }`) and one past the daily GPU budget is `503 GENERATION_BUSY` (§9). `POST /plans` and `POST /plans/{id}/execute` answer the same way: an over-budget plan or execution is `402`, a spent GPU budget `503`, and an unowned context asset `404`.

## 3. WebSocket protocol

`GET /v1/ws`, authenticated on connect. JSON messages:

Client → server:
```json
{ "t": "sub", "topics": ["job:job_01…", "asset:sha256:…", "project:prj_01…"] }
{ "t": "unsub", "topics": [...] }
```
Server → client:
```json
{ "t": "job.progress",  "jobId": "job_…", "stage": "separation", "pct": 0.42, "etaSec": 18 }
{ "t": "job.partial",   "jobId": "job_…", "index": 1, "output": { "asset": "sha256:…", "kind": "preview" },
  "outputs": { "assets": { "candidate_0": "sha256:…" }, "blobs": { "candidate_0": "sha256:…" } } }
{ "t": "job.completed", "jobId": "job_…", "outputs": {...} }
{ "t": "job.failed",    "jobId": "job_…", "code": "MODEL_ERROR", "retryable": true }
{ "t": "analysis.partial", "assetHash": "sha256:…", "stage": "rhythm", "blob": "sha256:…" }
{ "t": "sync.remote",   "projectId": "prj_…", "commits": ["cmt_…"] }
```
The client reconnects with exponential backoff and re-subscribes. After reconnecting it calls `GET /jobs/{id}` to fetch any missed final states.

> **Note (WP-0.7):** the `JobEvent` envelope (§4.2) carries neither the stage nor a partial index, so the gateway fills `stage` from the job's capability (`analysis.rhythm` → `rhythm`) and numbers `partial` messages itself, per job.
>
> **Note (WP-2.7):** `job.partial` keeps `output` and adds `outputs`, the worker's partial outputs verbatim (09 §5), so a client reads a candidate's asset and its gate-result blob together. Every hash a partial carries is registered as a derived asset of the job's user as soon as the event arrives, so `GET /assets/{hash}/url` works before the job completes.

## 4. Jobs & events (NATS JetStream)

### 4.1 Streams and subjects
| Stream | Subjects | Retention | Consumers |
|---|---|---|---|
| `JOBS` | `jobs.<capability>.<priority>`, e.g. `jobs.analysis.separation.interactive`, `jobs.generate.extend.background` | Work-queue | One durable pull consumer per capability group (workers) |
| `EVENTS` | `events.job.<jobId>`, `events.asset.<hash>`, `events.project.<id>` | Limits (24 h) | Orchestrator, WebSocket gateway |

Capabilities (v1): `analysis.{ingest,rhythm,structure,separation,harmony,stem_activity,loudness_energy,energy_stems,embed_full,section_embed,stem_embed,tag,describe,drum_split,transcribe,lyrics}`, `embed.project`, `embed.constellations`, `generate.{extend,inpaint,stem,text2music,fx,transition,variation}`, `generate.warmup` (internal: the API's warm-up ping, 09 §5), `transform.{timbre,style,stem_resynth}`, `fusion.{align,mashup_plan}`.

### 4.2 Envelopes (`packages/schemas/jobs/`)
```ts
interface JobRequest {
  schemaVersion: 1; capability: string; priority: "interactive" | "background";
  jobId: JobId; userId: UserId; projectId?: ProjectId;
  inputs: { assets: Record<string, AssetHash>; blobs?: Record<string, AssetHash>; params: object };  // params schema per capability
  idempotencyKey: string;        // hash(capability, inputs, stageVersion), used for result caching
  attempt: number; deadline: ISODate; traceparent: string; createdAt: ISODate;
}
interface JobEvent {
  schemaVersion: 1;
  jobId: JobId; type: "started" | "progress" | "partial" | "completed" | "failed";
  pct?: number; etaSec?: number;
  outputs?: { assets?: Record<string, AssetHash>; blobs?: Record<string, AssetHash> };
  error?: { code: string; message: string; retryable: boolean };
  metrics?: { gpuSeconds: number; model: string; modelVersion: string; worker: string };
}
```
Both carry `schemaVersion: 1` because they travel on their own ([01 §7](01-architecture.md)) — a request sits in NATS and an event goes over the WebSocket, with no project document to version them. `traceparent` is the W3C Trace Context header, propagated HTTP → NATS → worker spans (§11). `capability` is one of §4.1's, and `params` is the capability's own schema.

### 4.3 Worker contract (`bragi_common`)
1. Pull a message from its capability subject (interactive subjects are polled first).
2. Check the **result cache** (`job_results` by `idempotencyKey`). On a hit, publish `completed` immediately.
3. Download inputs from S3 to local scratch (verifying hashes).
4. Run. Publish `progress` at most 2×/s and `partial` outputs when available. Send JetStream in-progress acks every 10 s.
5. Upload outputs (content-addressed), publish `completed`, and ack. A capability may record
   `JobMetrics` through its context (`JobContext.record_metrics`); the worker attaches them to the
   `completed` event's `metrics` field (§4.2).
6. On exception: publish `failed{retryable}`. A NAK with delay is a retry. The orchestrator owns the retry count.

Workers are stateless, run one job per GPU at a time (configurable), and handle SIGTERM gracefully (finish or NAK within 30 s).

### 4.4 Orchestration
- `api-orchestrator` holds the **analysis DAG definitions** ([04 §2](04-analysis-pipeline.md)) and generation multi-step plans ([06 §5](06-ai-planner.md)).
- When a job completes, it records the result, publishes `analysis.partial`/`job.completed` on `events.*`, and enqueues dependents whose inputs are ready.
- **Cancellation:** `DELETE /jobs/{id}` marks the job cancelled. Workers check a cancel flag (NATS KV `cancel.<jobId>`) between chunks.

## 5. Database schema (Postgres)

```sql
users(id, email, name, created_at, plan, settings jsonb)                    -- + Better Auth tables
assets(hash pk, mime, bytes, sample_rate, channels, duration_samples, derived_from jsonb, created_at)
user_assets(user_id, hash, role text, created_at, primary key(user_id, hash)) -- ownership / access
library_items(id, user_id, asset_hash, filename, title, artist, album, imported_at, project_id null, hidden bool)
analyses(asset_hash, stage, stage_version, status, blob_hash, error jsonb, updated_at, primary key(asset_hash, stage, stage_version))
projects(id, user_id, title, created_at, updated_at, deleted_at)
commits(id pk, project_id, parents text[], batch jsonb, snapshot_hash, state, candidate_group, device_id, created_at, seq bigserial)
refs(project_id, name, commit_id, updated_at, primary key(project_id, name))  -- 'head:<deviceId>', 'branch:<name>', 'star:<commit>'
jobs(id, user_id, project_id, capability, priority, status, params jsonb, outputs jsonb, error jsonb, gpu_seconds, created_at, finished_at)
job_results(idempotency_key pk, outputs jsonb, created_at)
embeddings(id, asset_hash, scope text /*song|section|stem*/, scope_ref text, model text, vec vector(512))  -- HNSW index on vec
library_layouts(user_id, lens, version, blob_hash, updated_at, primary key(user_id, lens))
usage_ledger(id, user_id, job_id, credits numeric, capability, tier, reason, created_at)
plans(id pk, user_id, plan jsonb, created_at, expires_at)                   -- proposed plans awaiting execute (06 §5)
```

`jobs.status` is `queued | running | paused | done | failed | cancelled`; `paused` is a generation job the budget guard recorded but did not enqueue (§9). `usage_ledger.capability` and `.tier` say what the credits bought; `tier` is null for capabilities without latency tiers. `plans` rows are the planner's proposals; execute reads one by id for 24 hours (`expires_at`) and an expired row is a `404`, never a second execution path.
- Embeddings are keyed by **asset**, not by user, so identical audio is embedded once. Access is controlled through `user_assets`.
- Search queries join `embeddings` → `user_assets` (user's own) → `library_items`.
- **Better Auth owns `user`, `session`, `account` and `verification`** (05 §8); the `users(...)` row above is Better Auth's `user` plus the application's `plan` and `settings` columns. The API's migrations create all four tables (WP-0.7).

## 6. Object storage layout

```
s3://bragi-blobs/sha256/<aa>/<bb>/<full-hash>          # all assets & blobs, immutable
```
- Ownership lives in `user_assets`. Blobs are **never** publicly readable.
- **GC:** a nightly job deletes blobs not referenced by any `user_assets`, `analyses`, `commits.snapshot_hash`, `job_results` or `library_layouts` for 30 days. Discarded AI candidates naturally fall out this way.
- Uploads over 64 MB use multipart presigned uploads.

## 7. Sync protocol (local-first)

> **Deferred (WP-2.9, owner decision 2026-10-21).** Bragi runs on one machine for now; this protocol is the design for when multi-device sync is picked up later. Until then nothing pushes or pulls commits: the local history is the only copy.

The client is the primary editor. The server is a durable replica plus the cross-device hub.

**Push** (client → server), whenever online and there are unsynced commits:
1. Upload any missing snapshot and asset blobs (`/assets/presign`, skip if exists).
2. `POST /projects/{id}/commits` with the commits in topological order. The server validates parents exist, computes `seq`, and ignores duplicates (idempotent by commit ID).
3. `PUT /projects/{id}/refs` with CAS for `head:<deviceId>` and any branch refs.

**Pull**: `GET /projects/{id}/commits?since=<seq>` on project open, on reconnect, and on `sync.remote` WS events.

**Conflicts:** commits never conflict (immutable, content-addressed). Only **refs** can diverge. Each device has its own `head:<deviceId>` ref. Named branches use CAS. On CAS failure, the client fetches and shows "This branch changed on another device", then lets the user pick or create a new branch name. Bragi never auto-merges document content ([02 §7](02-song-model.md)).

**Local DB schema** (SQLite, shared by both platforms) mirrors `projects`, `commits`, `refs`, `library_items`, `analyses` (cache), `assets` (cache metadata + `local_path`/OPFS path), `embeddings` (cached vectors for the Universe as raw f32 blobs), `sync_state(project_id, last_seq, dirty)` and `outbox(commit_id)`. Migrations live in `packages/schemas/sqlite/migrations/NNN_name.sql` and are applied by both `rusqlite` and sqlite-wasm.

## 8. Auth & accounts

**Auth mode** ([ADR-0014](decisions/ADR-0014-single-user-mode.md)): `BRAGI_AUTH_MODE = single-user | multi-user`, validated in the API config.

- **single-user** is the default for local use (`pnpm dev:backend`, the local integration stack). At startup the API idempotently creates one owner user (`BRAGI_OWNER_EMAIL`, default `owner@bragi.local`; `BRAGI_OWNER_NAME`, default `Owner`), and every HTTP request and WebSocket connection resolves to it with no cookie or token. The switch is in the one session resolver (`services/api/src/auth/session.ts`), so ownership checks (`user_assets`, library, jobs, analyses) are unchanged. There is no sign-in form, on web or desktop.
- **Safety:** in single-user mode the API refuses to start unless `API_HOST` is a loopback address (`127.0.0.0/8`, `::1`, `localhost`). `BRAGI_ALLOW_REMOTE_SINGLE_USER=1` overrides this (a container binds `0.0.0.0`) and is logged as a warning.
- **multi-user** is the default for compose and any hosted deployment, and is everything below.

- **Better Auth** with email magic link + Google + GitHub OAuth.
- **Desktop (multi-user only, WP-2.9):** opens the system browser at `/v1/auth/desktop/start?code_challenge=…`, which redirects to `bragi://auth/callback?code=…`. The app exchanges the code for a long-lived refresh token and short-lived access token, and stores the refresh token in the OS keychain.
- **Anonymous / offline use:** the desktop app works without an account for local playback and editing of non-AI features (no analysis beyond what can run locally, see §10). The web app requires sign-in for uploads (storage costs money).
- **Account deletion:** removes the user's rows. Unreferenced blobs are GC'd. Analysis results keyed by hash may survive if another user owns the same asset, but they are not linked to the deleted user.

## 9. GPU cost and scaling

GPU inference cost is the core business risk (R6), so it's designed in from the start.

| Lever | Spec |
|---|---|
| **Result caching** | `idempotencyKey` cache for every job. Analysis is deduped across users by asset hash. |
| **Priority queues** | `interactive` (the user is waiting) is always served before `background` (library imports, prefetch). |
| **Preview tiers** | Generation produces a fast low-quality preview first, then the HQ result only for the accepted candidate ([09 §5](09-generation.md)). |
| **Lazy upgrade** | Library songs get `quick` analysis. `standard` runs only on first open. |
| **Autoscaling** | Scale GPU workers per capability on queue depth and age. Generation pools scale to zero after 10 idle minutes. Analysis keeps one warm worker in prod. |
| **Provider** | Containers are provider-agnostic. Evaluate serverless GPU platforms vs. AWS GPU instances in ADR-0005. The worker image must run on both. |
| **Credits** | Each capability has a credit cost (`config/credits.toml`), e.g. `quick` analysis = 0, `standard` = 1, extend 30 s = 2, full text2music = 10. `usage_ledger` records each job. A free tier gets N credits/day. |
| **Budget guard** | Global daily GPU-seconds cap per environment. When exceeded, background jobs pause and interactive jobs get a "busy" message. |
| **Warm-up** | `POST /generations/warmup` loads the routed model before the first interactive generation (09 §5). `BRAGI_GENERATE_WORKERS` says whether a generation worker runs against this environment; unset answers `disabled`. `pnpm dev:backend` sets it because it starts the worker; compose has no generation pool. |

**Credit formula (WP-2.7).** `config/credits.toml` holds `window_sec` and one cost per capability: `per30s` is charged per started 30 s of requested **new** audio (the overlap the model re-creates is free), per candidate; `flat` is charged once per job. `generate.extend` is `per30s = 2`, so 15 bars at 120 BPM in 4/4 (30 s) costs 2 credits per candidate: the default three previews cost 6, and the HQ re-render of one accepted candidate costs 2. Preview and HQ are charged the same (09 §5). Every charged submit writes one `usage_ledger` row with the credits, capability and tier. Analysis is free for now. The allowance is `BRAGI_DAILY_CREDITS`; unset means unlimited in single-user mode (jobs are still recorded) and `[daily].multi_user_credits` from the table in multi-user mode. Over it, the submit is `402 INSUFFICIENT_CREDITS` with `details: { required, used, allowance }`.

**Budget guard (WP-2.7).** `BRAGI_GPU_SECONDS_PER_DAY` (unset = no cap) is compared with the sum of `jobs.gpu_seconds` for jobs that finished since UTC midnight, i.e. the `JobMetrics.gpuSeconds` the worker recorded (§4.2). Past the cap, an interactive generation submit is `503 GENERATION_BUSY` and a background one is recorded as `paused` without being published or charged. A paused job is not resumed automatically; the client sees `status: "paused"` in `GET /jobs/{id}` and retries (or the next environment restart/queue policy picks it up, which is out of scope for v1).

The allowance check is a read of today's ledger, not a reservation: two submits racing can overshoot by one job each. Credit accounting is per submitted job, so a `job_results` cache hit is still charged; the cache saves GPU time, not the user's credits.

## 10. Bring-your-own-backend and local compute (post-v1, but designed for now)

- Desktop Settings → "Compute server" accepts any Bragi API base URL. The full stack runs via `infra/docker-compose.yml` on a user's own GPU box, which fits users with local AI setups.
- Later, a **lightweight local mode** could run a subset of workers (ingest, rhythm, tag) as a Python sidecar bundled with the desktop app. This is out of scope for v1, but the job protocol must not assume cloud-only features.

## 11. Observability and limits

- OpenTelemetry traces propagate `traceparent` from HTTP → NATS headers → worker spans. Metrics: queue depth, job latency per capability, GPU seconds, cache hit rate, WebSocket connections.
- Rate limits per user: 10 interactive jobs concurrent, 100 req/min API, 500 library imports/hour.
- Structured JSON logs. No audio content or lyrics in logs.

## 12. Privacy

- User audio, stems, lyrics and projects are **private** by default and never used to train models.
- Third-party LLM calls (planner, describe) go through **OpenRouter** and the provider it routes to, and send **features and text summaries, never audio, lyrics or titles**. Requests set `provider.data_collection: "deny"` by default (OpenRouter then only routes to providers that do not retain or train on prompts; `OPENROUTER_DATA_COLLECTION=allow` relaxes it). The key is `OPENROUTER_API_KEY`, held server-side only. This is documented in the privacy notice ([ADR-0012](decisions/ADR-0012-describe-llm-client.md)).
- Users can export everything (projects as JSON + assets zip) and delete everything.
