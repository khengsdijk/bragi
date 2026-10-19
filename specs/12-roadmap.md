# 12 — Roadmap & Work Packages

Status: Draft v0.2

Bragi is built in **phases**. Every phase ends with a demo-able milestone (matching the success criteria in [00 §9](00-vision.md)). Each phase is split into **work packages (WPs)**: units of work that one agent (or person) can pick up, implement and verify independently once their dependencies are done.

## How to use this document

- Pick the lowest-numbered WP whose `Depends on` are all **Done**. WPs within a phase without mutual dependencies can run in parallel.
- Before starting, read every spec listed under **Specs**.
- A WP is **Done** only when all its acceptance criteria pass and the [Definition of Done](13-agent-guide.md#4-definition-of-done) is met.
- Update the status table (§8) in the same PR that completes a WP.
- Sizes: **S** ≈ 1–2 days, **M** ≈ 3–5 days, **L** ≈ 1–2 weeks of focused work.

---

## Phase 0: Foundations

### WP-0.1 Monorepo scaffold & CI · S
- **Depends on:** none · **Specs:** [01 §4](01-architecture.md), [13](13-agent-guide.md)
- **Scope:** pnpm workspaces + Turborepo, Cargo workspace, uv workspace, all directories from [01 §4](01-architecture.md) with placeholder READMEs. Linting/formatting: Biome (TS), rustfmt + clippy, ruff + mypy. `infra/docker-compose.yml` with Postgres+pgvector, MinIO, NATS JetStream, Mailpit. A single local verification command, `pnpm verify`, covering lint + build + test for all three languages, plus a GitHub Actions workflow that mirrors it across the three OSes — committed and kept correct, but dormant ([13 §6](13-agent-guide.md)).
- **Acceptance:** `pnpm verify` succeeds on the development machine and `docker compose up` brings all infra services to healthy. (Originally "succeeds on all three OSes in CI"; hosted CI was dropped on 2026-10-18 because this is a solo project, so cross-OS coverage is now whatever the owner's machines prove — recorded in [15-open-questions.md](15-open-questions.md).)

### WP-0.2 Schemas & codegen · M
- **Depends on:** 0.1 · **Specs:** [01 §7](01-architecture.md), [02](02-song-model.md)
- **Scope:** `packages/schemas` containing the JSON Schemas for the song document, all v1 ops, analysis blobs, job envelopes and the API error codes. Codegen produces TS types + Ajv validators, Rust types via `typify` (into `bragi-model`), and Python Pydantic v2 models (into `bragi_common`). A `pnpm schemas:gen` command, plus a CI check that generated code is up to date.
- **Acceptance:** the example document in [02 §10](02-song-model.md) validates in all three languages. Round-tripping JSON → typed → JSON is lossless in all three.

### WP-0.3 `bragi-model` core + WASM · L
- **Depends on:** 0.2 · **Specs:** [02](02-song-model.md)
- **Scope:** time mapping (ticks/seconds/bar-beat with tempo maps), `validate` (all invariants in [02 §4.3](02-song-model.md)), `apply` for all v1 ops **except** `analysis.apply` and `region.adopt`, `section_spans`, `resolve_region`, `canonical_json`, the commit hash function, and `diff` → `EngineDelta`. The `packages/model-wasm` build exposes handle-based APIs. Unit tests for every op, snapshot tests (`insta`), and proptest-based fuzzing (random valid batches never produce invalid docs).
- **Acceptance:** 100% of ops have tests. Fuzzing runs for 10k iterations with no panics. WASM bundle < 1.5 MB gzipped. `apply` of a 50-op batch on a 10-minute doc takes < 5 ms in WASM.

### WP-0.4 Spike: time-stretch / pitch-shift (→ ADR-0002) · M
- **Depends on:** 0.1 · **Specs:** [03 §7](03-audio-engine.md)
- **Scope:** evaluate Signalsmith Stretch (native + WASM build feasibility), the pure-Rust phase vocoder, and the Rubber Band licence implications. Implement the `Stretcher` trait with the chosen implementation(s) in `bragi-dsp`.
- **Acceptance:** ADR-0002 written with listening notes and CPU numbers. The trait implementation passes: ratio 1.0 is bit-exact pass-through, and a ±12% stretch of drum fixtures shows no audible flamming (owner listening check). The WASM build works in an AudioWorklet test page.

### WP-0.5 Platform shell: web + Tauri boot the same app · M
- **Depends on:** 0.1 · **Specs:** [01 §3, §5](01-architecture.md)
- **Scope:** `packages/app` minimal routes (`/`, `/song/:id`, `/universe`, `/fuse`). `packages/platform` interfaces with **web** and **tauri** implementations of LocalDB (sqlite-wasm/OPFS vs rusqlite) and BlobCache (OPFS vs filesystem). FileAccess. The `apps/web` Vite config serves COOP/COEP headers in dev and preview. The `apps/desktop` Tauri 2 app loads the same bundle with Tauri permissions configured. SQLite migrations shared from `packages/schemas/sqlite/migrations`.
- **Acceptance:** the same e2e test (create a dummy project, store it, reload, read it back) passes in Chromium, Firefox, Safari (web) and in Tauri on macOS, Windows and Linux. `crossOriginIsolated === true` on web.

### WP-0.6 Design tokens & base components · M
- **Depends on:** 0.1 · **Specs:** [11 §3](11-ux-and-accessibility.md)
- **Scope:** finalise the font choice, role and section colours, and energy gradient. `tokens.css` + `tokens.json`. Radix-based components: Button, IconButton, Slider (incl. bipolar vibe slider), Popover, Menu, Dialog, Tabs, Tooltip, Toast, CommandPalette, Chip. A Storybook (or Ladle) for components.
- **Acceptance:** all tokens pass contrast checks (script). Colour-blind simulation snapshots exist. axe passes on all stories.

### WP-0.7 Backend & worker skeleton · L
- **Depends on:** 0.2 · **Specs:** [05](05-backend-and-jobs.md)
- **Scope:** Fastify app with config validation, Better Auth (magic link via Mailpit locally, plus GitHub OAuth), Postgres migrations for all tables in [05 §5](05-backend-and-jobs.md), asset presign/complete/url endpoints, a WebSocket gateway, NATS streams, and `api-orchestrator` with the DAG executor. `bragi_common` Python worker framework (pull, result cache, S3 IO, progress, cancel) and an `echo` capability for testing. OpenTelemetry end to end.
- **Acceptance:** an integration test (docker compose) logs in, uploads a file, submits an `echo` job, receives `progress` + `completed` over WebSocket, and shows one trace spanning API → NATS → worker.

---

## Phase 1: "See your song" (Milestone M1 = success criterion 1)

### WP-1.1 Audio engine v1 (both hosts) · L
- **Depends on:** 0.3, 0.4, 0.5 · **Specs:** [03](03-audio-engine.md)
- **Scope:** symphonia decoding, render plan compiler, transport state machine, gain/pan/mute/solo, fades, warp `none`/`beatgrid`, chunk pool (web) and PCM mmap cache (desktop), `EngineHost` both implementations, peak pyramids, meters, offline render (mixdown). The conformance suite with golden fixtures.
- **Acceptance:** [03 §5.2](03-audio-engine.md) timing targets are met. WASM-vs-native null test ≤ −90 dBFS on fixtures. No audio-thread allocation (assert_no_alloc). 12-track playback has no underruns at the target buffer sizes.

### WP-1.2 Workers: ingest, rhythm, loudness_energy · M
- **Depends on:** 0.7 · **Specs:** [04 §3.1, §5.1, §5.5](04-analysis-pipeline.md)
- **Acceptance:** eval gate for rhythm (beat F ≥ 0.85) on the eval set. Ingest rejects corrupt/too-long files with correct codes. The energy curve has the documented hop and range.

### WP-1.3 Worker: separation (+ bake-off → ADR-0004 part 1) · L
- **Depends on:** 0.7 · **Specs:** [04 §4](04-analysis-pipeline.md)
- **Scope:** benchmark candidates, implement the chosen model with chunking, residual computation and silent-stem dropping. Write the first `MODELS.md` entries.
- **Acceptance:** Σ stems + residual nulls against the working mix ≤ −60 dBFS. A 4-min song separates in < 40 s on the reference GPU. Licences are recorded.

### WP-1.4 Worker: structure · M
- **Depends on:** 1.2 · **Specs:** [04 §5.2](04-analysis-pipeline.md)
- **Acceptance:** eval gates (boundary hit-rate ≥ 0.70, label accuracy ≥ 0.60). `repeatGroup` correctly groups choruses on ≥ 80% of eval songs with ≥ 2 choruses.

### WP-1.5 Worker: harmony · M
- **Depends on:** 1.3 · **Specs:** [04 §5.3](04-analysis-pipeline.md)
- **Acceptance:** chord accuracy ≥ 0.70 and key accuracy ≥ 0.80 on the eval set. `progressionFingerprint` is key-invariant (a transposed fixture gives the same fingerprint).

### WP-1.6 Workers: embeddings, tags, stem_activity · M
- **Depends on:** 1.3, 1.4 · **Specs:** [04 §5.4, §6.1, §6.2](04-analysis-pipeline.md)
- **Scope:** CLAP embedding at song/section/stem scope, taxonomy file, trained MLP heads (training script + reproducible notebook in `services/workers/embed/training/`), zero-shot descriptors, pgvector storage.
- **Acceptance:** top-3 genre agreement ≥ 0.70. The text query "drums" ranks drum stems above other stems for ≥ 90% of eval songs.

### WP-1.7 Worker: describe · S
- **Depends on:** 1.4, 1.5, 1.6 · **Specs:** [04 §6.3](04-analysis-pipeline.md)
- **Acceptance:** 0 hard failures on the eval checklist. The grounding post-check rejects injected hallucinated instruments (unit test).

### WP-1.8 `analysis.apply` + progressive merge · M
- **Depends on:** 0.3 · **Specs:** [02 §6](02-song-model.md)
- **Acceptance:** property test: all permutations of stage arrival on a *pristine* document yield identical documents. Late structure on an edited doc yields `suggestedSections` instead of re-splitting.

### WP-1.9 Song Canvas renderer v1 (view + playback) · L
- **Depends on:** 0.5, 0.6, 1.1 · **Specs:** [07 §1, §2, §5, §8, §9](07-song-canvas.md), [11 §6.1](11-ux-and-accessibility.md)
- **Scope:** PixiJS stage with skyline, section blocks, harmony strip, ribbons, beat grid, playhead, zoom/pan (L2 levels), selection model, solo/mute from ribbons, progressive states with shimmer, the accessible DOM grid, and the transport bar.
- **Acceptance:** [07 §9](07-song-canvas.md) budgets are met. WebGL2 fallback visual snapshots match. Accessible grid content matches the document (test).

### WP-1.10 Upload → project → live analysis flow · M
- **Depends on:** 0.7, 1.8, 1.9 (and the 1.2–1.7 workers for the full demo) · **Specs:** [01 §6](01-architecture.md), [05 §2–3](05-backend-and-jobs.md)
- **Scope:** drop zone, hashing in a worker, dedupe, presigned upload, `POST /analyses`, WebSocket subscription, merging `analysis.partial` into the doc, lazy stem downloads, a simple library list.
- **Acceptance:** **M1 demo:** dropping a 4-min fixture song gives a playable canvas with all stages in ≤ 60 s (reference GPU), and every stem is soloable. Works on web and desktop.

### WP-1.11 Export v1 · S
- **Depends on:** 1.1 · **Specs:** [03 §9](03-audio-engine.md)
- **Acceptance:** WAV/FLAC mixdown and stems export. The exported mixdown of an unedited project nulls against the working asset ≤ −60 dBFS.

---

## Phase 2: "Shape your song" (M2 = success criteria 2, 4)

### WP-2.1 Version tree & history · M
- **Depends on:** 0.3, 1.10 · **Specs:** [02 §7](02-song-model.md), [07 §7](07-song-canvas.md)
- **Scope:** commits in LocalDB, refs, undo/redo, branch creation, the history panel, checkout, star, and `region.adopt` (model op + UI "Take this part from…").
- **Acceptance:** undo restores a deep-equal doc after any op. 1 000 commits load in the history panel in < 200 ms.

### WP-2.2 Section editing interactions · L
- **Depends on:** 2.1 · **Specs:** [07 §4.1–4.2](07-song-canvas.md), [02 §5](02-song-model.md), [03 §5.3](03-audio-engine.md)
- **Scope:** drag reorder (live preview), duplicate, remove, edge resize (trim/loop/stretch), split, smart transitions, context menu, keyboard alternatives.
- **Acceptance:** [07 §10](07-song-canvas.md) checks 1 and 6. No clicks at new boundaries in renders (automated discontinuity check).

### WP-2.3 FX catalogue, macros & Inspector · L
- **Depends on:** 1.1 · **Specs:** [03 §6](03-audio-engine.md), [07 §4.5](07-song-canvas.md)
- **Acceptance:** every FxType has DSP unit tests (impulse/frequency response where applicable), param smoothing without zipper noise, and catalogue-driven UI. Macros produce `macroOwned` fx and stay in sync with the Inspector.

### WP-2.4 Paint brushes (instant set) · M
- **Depends on:** 2.3 · **Specs:** [07 §4.4](07-song-canvas.md)
- **Acceptance:** [07 §10](07-song-canvas.md) check 3. Pen pressure works in Chromium and Safari with pointer events.

### WP-2.5 Audition engine & Audition bar · M
- **Depends on:** 1.1, 2.1 · **Specs:** [03 §5.4](03-audio-engine.md), [07 §6](07-song-canvas.md)
- **Acceptance:** [07 §10](07-song-canvas.md) check 4. Candidate state badges update from job events. Accept/discard/more-like-this semantics follow [02 §7](02-song-model.md).

### WP-2.6 Planner v1: ops-only plans, explain, lasso & prompt bar · L
- **Depends on:** 2.3, 2.5 · **Specs:** [06](06-ai-planner.md) (§1–5, §7–9), [07 §4.3, §4.9](07-song-canvas.md), [10 §7](10-fusion.md)
- **Scope:** `summarize_for_llm`, the capability catalogue generator, the Claude tool-use call with model tiering, validation + repair round, the explain endpoint, the planner bench (ops-only cases), lasso tool, prompt bar with local suggestion chips, and the artist-name → descriptor policy.
- **Acceptance:** planner bench metrics for ops-only cases ([06 §9](06-ai-planner.md)). The prompt-injection test passes. The policy tests in [10 §8](10-fusion.md) check 3 pass for the planner path.

### WP-2.7 Generation infrastructure + `generate.extend` (→ ADR-0004) · L
- **Depends on:** 0.7, 1.10, 2.5 · **Specs:** [09 §1–3, §4.2, §5, §6, §8](09-generation.md), [05 §9](05-backend-and-jobs.md)
- **Scope:** model bake-off, the `GenerationBackend` adapter and routing table, preview/HQ tiers, `postprocess.py` quality gates, engine `context` renders, the extend handle UI, separation of generated audio into existing tracks, credits + usage ledger, and the warm-up ping.
- **Acceptance:** [09 §9](09-generation.md) checks 1, 2 and 4. **M2 demo 2** works end-to-end.

### WP-2.8 Inpaint, erase & fill, AI transitions, planner generation steps · M
- **Depends on:** 2.6, 2.7 · **Specs:** [09 §4.3–4.4](09-generation.md), [06 §3, §5](06-ai-planner.md), [07 §4.8](07-song-canvas.md)
- **Acceptance:** **M2 demo 4** (lasso + prompt with a generative variant) works end-to-end. Fill-gap candidates pass the gates on 4 of 5 fixtures.

### WP-2.9 Sync & desktop auth · M
- **Depends on:** 2.1, 0.7 · **Specs:** [05 §7–8](05-backend-and-jobs.md)
- **Acceptance:** two devices editing offline then syncing produce two branch tips with no data loss. The desktop PKCE login works on all three OSes, and the token is stored in the OS keychain.

---

## Phase 3: "Your Universe" (M3 = success criterion 5)

### WP-3.1 Library import at scale + preview snippets · M
- **Depends on:** 1.10 · **Specs:** [08 §9](08-universe.md), [04 §3](04-analysis-pipeline.md)
- **Scope:** folder import, metadata parsing, parallel uploads, near-duplicate detection, the desktop watched folder, the `quick` profile and lazy upgrade, and the preview snippet stage.
- **Acceptance:** importing 500 songs completes `quick` analysis with stars appearing progressively, and the UI stays at 60 fps throughout.

### WP-3.2 Projection, clustering & naming · M
- **Depends on:** 1.6, 3.1 · **Specs:** [08 §2, §4](08-universe.md)
- **Acceptance:** [08 §10](08-universe.md) checks 1, 2 and 3.

### WP-3.3 Universe renderer & lenses · L
- **Depends on:** 0.6, 3.2 · **Specs:** [08 §3, §7, §8](08-universe.md), [11 §6.1](11-ux-and-accessibility.md)
- **Acceptance:** [08 §10](08-universe.md) check 5. Hover-to-hear plays within 300 ms of hover intent. The accessible tree matches the clusters.

### WP-3.4 Search · M
- **Depends on:** 1.6, 3.3 · **Specs:** [08 §6](08-universe.md)
- **Acceptance:** [08 §10](08-universe.md) check 4. Offline song search on desktop returns results in < 150 ms for 50k songs.

### WP-3.5 Constellations · M
- **Depends on:** 1.5, 3.3 · **Specs:** [08 §5](08-universe.md)
- **Acceptance:** each edge type has a fixture-based test. Clicking an edge opens a comparison card with A/B playback.

### WP-3.6 Universe ↔ Song zoom transition · S
- **Depends on:** 1.9, 3.3 · **Specs:** [08 §7](08-universe.md)
- **Acceptance:** the transition holds ≥ 50 fps and the back navigation reverses it. Reduced motion falls back to a cross-fade.

### WP-3.7 Paths: playlist & mix projects · M
- **Depends on:** 3.3, 2.2 · **Specs:** [08 §7.1](08-universe.md)
- **Acceptance:** an 8-song path has no BPM jump > 8% unless unavoidable (logged). The Mix project opens in the canvas with beat-matched transitions.

### WP-3.8 (3b) Hum search · M
- **Depends on:** 3.4, 6.2 (transcribe) · **Specs:** [08 §6](08-universe.md)

---

## Phase 4: "Create" (M4 = success criteria 3, 6)

| WP | Title | Size | Depends on | Specs | Key acceptance |
|---|---|---|---|---|---|
| 4.1 | `generate.stem` + "Regenerate part" + ✨ More drums brush | L | 2.7 | [09 §4](09-generation.md), [07 §4.4–4.5](07-song-canvas.md) | Generated stem lands on the right track, passes the gates, and is key/tempo-conformant |
| 4.2 | Energy skyline compiler + skyline editing | L | 2.3, 2.5, 4.1 | [06 §6](06-ai-planner.md), [07 §4.6](07-song-canvas.md) | Compiler snapshot tests. **M4 demo 3.** |
| 4.3 | Timbre swap (Strategy A) + `transcribe` stage | L | 2.7 | [09 §4.7](09-generation.md), [04 §7](04-analysis-pipeline.md) | Piano → strings on 3 fixtures keeps the melody (note-onset F ≥ 0.8 vs source transcription) |
| 4.4 | `text2music` + Create dialog | M | 2.7 | [09 §4.1](09-generation.md) | New song is editable (stems, sections) within 90 s of accept |
| 4.5 | Long-form mode + blueprint editor | L | 4.4, 2.8 | [09 §4.5](09-generation.md) | [09 §9](09-generation.md) check 3 |
| 4.6 | `generate.fx`, ✨ FX brushes, `stem_resynth` (Clean up) | M | 2.7 | [09 §4.6](09-generation.md), [07 §4.4](07-song-canvas.md) | Riser lands ending on a downbeat. Clean-up reduces separation-artifact score on fixtures. |
| 4.7 | Generate into empty space | M | 3.3, 4.4 | [08 §7.2](08-universe.md) | [08 §10](08-universe.md) check 6. **M4 demo 6.** |

## Phase 5: "Fuse" (M5 = success criterion 7)

| WP | Title | Size | Depends on | Specs | Key acceptance |
|---|---|---|---|---|---|
| 5.1 | Alignment + Fusion desk UI | M | 3.3, 1.5 | [10 §1–2](10-fusion.md) | [10 §8](10-fusion.md) check 1 |
| 5.2 | Mashup proposals + clash repair | L | 5.1, 2.5 | [10 §3](10-fusion.md) | [10 §8](10-fusion.md) checks 2 and 4. **M5 demo 7.** |
| 5.3 | Stem collage + ✨ Glue | M | 5.1, 2.7 | [10 §4](10-fusion.md) | Dropped stems are auto-conformed. Glue candidates pass the gates. |
| 5.4 | Style transfer | M | 2.7 | [10 §5](10-fusion.md) | Vocals preserved. Strength slider behaviour is monotonic on fixtures (embedding distance to B decreases as strength rises). |
| 5.5 | Blend slider | M | 4.4 | [10 §6](10-fusion.md) | Blend-strip previews ordered by embedding distance |
| 5.6 | Policy hardening | S | 2.6 | [10 §7](10-fusion.md) | [10 §8](10-fusion.md) check 3 on the direct API path, plus the voice-cloning refusal tests |

## Phase 6: Polish & ship

| WP | Title | Size | Depends on | Notes |
|---|---|---|---|---|
| 6.1 | Desktop packaging, signing, notarisation, auto-update | M | 0.5 | [01 §9](01-architecture.md) |
| 6.2 | Deep profile: drum split, transcribe, lyrics + lyrics lane | L | 1.3 | [04 §7](04-analysis-pipeline.md) (transcribe may land earlier via 4.3) |
| 6.3 | Onboarding, quests, demo songs | M | 2.7 | [11 §4](11-ux-and-accessibility.md) |
| 6.4 | Accessibility audit & fixes | M | all UI WPs | [11 §6.5](11-ux-and-accessibility.md) |
| 6.5 | Performance pass (all budgets) | M | all UI WPs | Budgets in 03, 07 and 08 |
| 6.6 | DAW export bundle | S | 1.11, 1.5 | [03 §9](03-audio-engine.md) |
| 6.7 | Bring-your-own-backend setting | S | 2.9 | [05 §10](05-backend-and-jobs.md) |
| 6.8 | Audio watermark evaluation & integration | S | 2.7 | [09 §8](09-generation.md) |
| 6.9 | GPU hosting decision & prod deploy (→ ADR-0005) | M | 2.7 | [05 §9](05-backend-and-jobs.md) |

## 7. Critical path

```
0.1 → 0.2 → 0.3 ──────────────┐
0.1 → 0.4 ────────────────────┼→ 1.1 → 1.9 → 1.10 (M1) → 2.1 → 2.5 → 2.7 (M2a) → 2.8 (M2) → 3.x (M3) → 4.x (M4) → 5.x (M5)
0.1 → 0.5 ────────────────────┘                  ▲
0.2 → 0.7 → 1.2/1.3 → 1.4/1.5/1.6 → 1.7 ─────────┘
```
The Rust engine (0.3/0.4/1.1) and the analysis workers (0.7/1.x) are independent tracks until WP-1.10. That makes them good to run in parallel.

## 8. Status

| WP | Status | Notes |
|---|---|---|
| 0.1 Monorepo scaffold & CI | **Done** (2026-10-18) | Plan: [`docs/wp/0.1.md`](../docs/wp/0.1.md). `pnpm verify` and `pnpm infra:up` green on macOS 15 / arm64 — the only machine used. Ubuntu and Windows are **unverified**: hosted CI was dropped the same day (Q11 in [15](15-open-questions.md)), and the committed workflow has never run. Reviewed by a fresh-context agent; its findings are resolved in the branch and recorded in the plan. |
| 0.2 Schemas & codegen | **Done** (2026-10-18) | Plan: [`docs/wp/0.2.md`](../docs/wp/0.2.md). Tooling decision: [ADR-0006](decisions/ADR-0006-schema-codegen.md). 63 root types across `song/`, `analysis/`, `jobs/` and `api/` generate TypeScript types + precompiled Ajv validators, Rust types (typify) and Pydantic v2 models, all from one bundle; `pnpm schemas:check` runs first in `pnpm verify` and in its own CI job. The 02 §10 example document validates and round-trips losslessly in all three languages. Verified on macOS 15 / arm64 only — the same unverified cross-OS caveat as 0.1 (Q11). |
| 0.3 `bragi-model` core + WASM | **Done** (2026-10-19) | Plan: [`docs/wp/0.3.md`](../docs/wp/0.3.md). Time mapping, `validate` (02 §4.3, all 7 invariants), `apply` for 27 of the 29 v1 ops (`analysis.apply` and `region.adopt` are WP-1.8's), `section_spans`, `resolve_region`, `canonical_json`, the commit hash and `diff → EngineDelta`. `packages/model-wasm` (`crates/bragi-model-wasm`) exposes the handle API. Proof: 10 000-iteration proptest (no panics), WASM bundle **0.426 MiB gzipped** (< 1.5 MB), and a 50-op batch on a ~20-minute document in **~1.6 ms** (< 5 ms; stricter than the 10-minute criterion). `sha2` added (MIT/Apache-2.0). Verified on macOS 15 / arm64 only (Q11). |
| 0.4 Time-stretch / pitch-shift spike | **In progress** (2026-10-18) | Plan: [`docs/wp/0.4.md`](../docs/wp/0.4.md); manual check: [`docs/wp/0.4-MANUAL_CHECKS.md`](../docs/wp/0.4-MANUAL_CHECKS.md). Trait + pure-Rust `PhaseVocoder` landed in `bragi-dsp::stretch`; contract, no-flam, no-alloc tests and the wasm AudioWorklet page pass; [ADR-0002](../specs/decisions/ADR-0002-time-stretch.md) written **Proposed**. **Blocked on the owner's ±12 % drum listening check** (ADR-0002 stays Proposed until then). |
| 0.6 Design tokens & base components | **Done** (2026-10-18) | Plan: [`docs/wp/0.6.md`](../docs/wp/0.6.md). `tokens.json` → `tokens.css` (generated, checked in), 164 contrast pairings pass in both themes, 50 stories × 2 themes pass axe with 0 serious/critical, colour-blind snapshots in `packages/design/snapshots/cvd/`, 141 Vitest tests. Font is *proposed* (Q8 in [15](15-open-questions.md)) pending the owner's sign-off. |
| 0.5 Platform shell | **Done on macOS; Windows/Linux desktop unverified** (2026-10-18) | Plan: [`docs/wp/0.5.md`](../docs/wp/0.5.md), which carries the platform table. E2e passed on Chromium, Firefox and **Playwright WebKit** (dev + production preview) and on **Tauri macOS** (selftest build, two process launches); `crossOriginIsolated` true on all six web runs; `pnpm verify` green. **Unverified:** Tauri on Windows and Linux (the `desktop-e2e-*` jobs in `ci.yml` have never run), real Safari (Playwright WebKit is the engine, not the browser) — all in **Q11**. |
| 0.7 Backend & worker skeleton | **Done** (2026-10-19) | Plan: [`docs/wp/0.7.md`](../docs/wp/0.7.md). Fastify `api` (+ `api-orchestrator`) with zod config, Better Auth (magic link via Mailpit; GitHub OAuth implemented but untested — it needs the owner's OAuth app), the 05 §5 migrations, asset presign/complete/url, the WebSocket gateway, the NATS `JOBS`/`EVENTS` streams + `cancel` KV, and the 04 §2 DAG executor; `bragi_common` Python worker framework (pull, result cache, S3 IO, progress, cancel, OTLP) plus the `echo` capability; OpenTelemetry spans API → NATS → worker. Acceptance: `pnpm test:integration` passes (`BRAGI_STACK=local` here — the compose `api`/`worker` images are committed but Docker Hub pulls are blocked in the sandbox used). macOS-only caveat as 0.1/0.2 (Q11). |
| 1.1 Audio engine v1 | **Done** (2026-10-19) | Plan: [`docs/wp/1.1.md`](../docs/wp/1.1.md). `bragi-engine` compiles the render plan (warp `none`/`beatgrid`/`stretch`, fades, gain/pan/mute/solo, sections, gain automation, delta recompiles), owns the transport (play/pause/stop/seek/loop/scrub/audition with a sample-accurate 5 ms loop crossfade), the allocation-free mixer (direct + `PhaseVocoder` paths, 5/10 ms ramps, safety limiter), the 2 s/256 MB chunk pool, min/max peak pyramids, meters, deterministic offline mixdown and the `assert_no_alloc` allocator guard. Proof: 12-track 60 s playback renders at **0.9 %/0.8 % of real time** at 128/256 frames with **0 underruns**; WASM-vs-native nulls at **−185 dBFS / −182 dBFS** on the gated fixtures (a phase-vocoder fixture is informational at −69 dB, Q31); `tests/no_alloc.rs` records **0 allocations** across 800 guarded blocks; the 03 §5.2 targets are measured in `tests/timing.rs`. `EngineHost` in both `packages/platform` adapters, `bragi-engine-native` (symphonia + mmap + cpal + Tauri commands) and `bragi-engine-wasm` (`pnpm test:conformance`, in `pnpm verify`). Deps: `symphonia` (MPL-2.0) and `cpal` (both named in 01 §1), `memmap2` (implements 01 §1's "memory-map large files" capability). |
| 1.8 `analysis.apply` + progressive merge | **Done** (2026-10-19) | Plan: [`docs/wp/1.8.md`](../docs/wp/1.8.md). `analysis.apply` implemented as a reconciler: it records a stage's typed `effects` in `AnalysisRef.effects` and rebuilds the analysis-owned tracks/sections/timebase from the *set* of recorded effects, so all 720 arrival permutations of the six effect-bearing stages produce byte-identical documents (proptest + exhaustive test). A late `structure` on an edited arrangement writes `meta.suggestedSections` (new schema shape) instead of re-splitting. Q12 (typed `effects[]`) and Q13 (`SectionSuggestion`) are resolved in the schemas and 02 §6; Q26 (`AnalysisRef.summary`) deferred to WP-1.10. No new dependencies. Verified on macOS 15 / arm64 only (Q11). |
| 1.11 Export v1 | **Done** (2026-10-19) | Plan: [`docs/wp/1.11.md`](../docs/wp/1.11.md). `bragi_engine::export` writes WAV (16/24-bit, 32-bit float) and FLAC (16/24-bit) mixdowns and per-track stems with seeded-or-no dither, portable file names and WAV INFO / Vorbis metadata; `EngineHost.render` now returns encoded files on both hosts (binary export frame over Tauri IPC and the worker), native stems render in parallel on rayon. Proof: an unedited project nulls against its working asset at **-inf dBFS (24-bit WAV/FLAC) and -101.1 dBFS (16-bit)**, against the <= -60 criterion (`crates/bragi-engine/tests/export.rs`, decoded back through symphonia); stems sum to the mixdown at -inf dBFS; native-vs-WASM export parity is part of `pnpm test:conformance`. Deps: `rayon` (MIT/Apache-2.0, named in 03 §3); the FLAC/WAV/MD5 code is in-repo. MP3 and `normalize` are not in this WP (Q37). Verified on macOS 15 / arm64 only (Q11). |
| 1.2 Workers: ingest, rhythm, loudness_energy | **Implemented; rhythm eval gate pending the owner's eval set** (2026-10-19) | Plan and outcome: [`docs/wp/1.2.md`](../docs/wp/1.2.md); ADR: [ADR-0007](decisions/ADR-0007-beat-tracking.md) (Proposed). `analysis.ingest` (ffmpeg → 48 kHz/stereo/24-bit FLAC, Chromaprint, peak pyramid; `ASSET_CORRUPT` / `ASSET_TOO_LONG` / `PAYLOAD_TOO_LARGE` / `UNSUPPORTED_MEDIA_TYPE`, all non-retryable via the new `JobFailure`), `analysis.rhythm` (Beat This! + a weight-free DSP fallback, shared post-processing) and `analysis.loudness_energy` (own BS.1770-4/R128, energy curve at the documented 0.5 s hop, 0..1) are in the worker. `fixtures/eval/manifest.json` (format + **empty** track list), `scripts/fetch-eval.sh` (fails clearly without credentials) and `pnpm eval:analysis` exist and are proven on synthetic click tracks. **The beat F ≥ 0.85 gate has NOT been run: there is no eval set** — the report says `PENDING`, and no eval number is claimed. `MODELS.md` created (Beat This! `final0`, MIT/MIT). macOS 15 / arm64 only (Q11). |
| 1.3 Worker: separation | **Implemented; GPU timing + eval bake-off pending** (2026-10-19) | Plan/outcome: [`docs/wp/1.3.md`](../docs/wp/1.3.md). `analysis.separation` (HTDemucs 6s, chunked + crossfaded, 48 kHz 24-bit FLAC stems, residual, silent-stem drop); Σ stems + residual nulls **bit-exactly** (acceptance ≤ −60 dBFS: met). 4-min song: 29.9 s on Apple MPS, 79.5 s on CPU; **reference-GPU time unmeasured**. Licences recorded in `services/workers/MODELS.md` (weights terms unclear, Q40). [ADR-0004](decisions/ADR-0004-separation-model.md) is **Proposed**: the bake-off ran on generated signals only, no quality numbers (Q42). |
| 1.9 Song Canvas renderer v1 | **Done** (2026-10-19) | Plan & outcome: [`docs/wp/1.9.md`](../docs/wp/1.9.md). `packages/render-canvas` (pure `viewport`/`selection`/`geometry`/`layout`/`progressive`/`palette` modules plus the PixiJS v8 `SongCanvas`, WebGPU→WebGL2 fallback), the Song Store + view model + accessible ARIA grid + transport bar in `packages/app`, and the browser `EngineHost` wiring WP-1.1 deferred (worklet command ring, SAB state block, asset decode), on a `/demo` route. Budgets (07 §9, 10-minute / 12-ribbon song): **59.8–60.0 fps** playing and zooming, **render p95 ≤ 2.97 ms / max ≤ 4.58 ms** (budget ≤ 8 ms), **first canvas warm median 106–133 ms, cold 200–228 ms** (budget < 500 ms) in Chromium WebGL2 *and* WebGPU. Visual fallback snapshots (WebGPU on/off against one golden, backend asserted), axe (**0 serious/critical**) and a keyboard-only path pass in both Chromium GPU projects; the accessible grid is checked against the **raw document JSON** (14 Vitest cases). Adds Q50–Q58. **Recorded on macOS 15 / arm64 only — an Apple-silicon GPU, not 07 §9's 2020-era integrated GPU; visual goldens are macOS (Q53, Q54). Firefox/WebKit e2e, the Linux golden run, and the full `pnpm verify` / `infra:up` are *unverified* here.** |
| 1.4 Worker: structure | **Done for the synthetic-proof machinery; real eval gates pending the owner's eval set** (2026-10-19) | Plan and outcome: [`docs/wp/1.4.md`](../docs/wp/1.4.md); ADR: [ADR-0010](decisions/ADR-0010-structure-segmentation.md) (Proposed). `analysis.structure` (`stageVersion` `structure@ssm-novelty-1`) is **weight-free** — beat-synchronous chroma + timbre + energy → self-similarity + Foote novelty → downbeat/2-/4-bar snapping → `repeatGroup` by aligned section similarity + average linkage → heuristic labels mapped to `SectionKind` by `config/structure_labels.json`. No schema change, no new dependency (NumPy/SciPy only), so it runs in `pnpm verify`. Proven on **synthetic** songs with an exact section plan: boundary hit-rate **1.000**, label accuracy **1.000**, chorus grouping **4/4 (100 %)** with the exact beat grid, all above the 0.70 / 0.60 / 80 % gates; ~0.9 ms per second of audio. **The real eval gates were NOT run: there is no eval set** — the report says `PENDING` and no eval number is claimed. Findings: a fallback-tracker grid on a silent lead-in adds one section (Q47); the label mapping stands in for `taxonomy.json` until WP-1.6 (Q46); the All-In-One upgrade path is Q44. macOS 15 / arm64 only (Q11). |
| All others | Not started | Specs v0.1 written 2026-10-18 |
