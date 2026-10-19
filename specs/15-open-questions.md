# 15 — Open Questions

Questions that need an answer before or during a specific work package. Add new ones at the bottom. When one is resolved, move it to "Resolved" with the answer and a link (ADR or spec section).

| # | Question | Needed by | Owner | Notes |
|---|---|---|---|---|
| Q2 | NATS JetStream vs Kafka. Is there any reason to align with Kafka early (familiarity, tooling)? | WP-0.7 | Koen | Contracts are broker-agnostic. Currently NATS. → ADR-0003 |
| Q3 | Which separation model(s) for v1, and are their weights licences acceptable? | WP-1.3 | Agent + Koen | Bake-off results |
| Q4 | Which generation model per capability (open weights vs hosted API), and their commercial terms | WP-2.7 | Koen | → ADR-0004 |
| Q5 | GPU hosting: serverless GPU platform vs AWS GPU instances | WP-6.9 (earlier for staging) | Koen | → ADR-0005 |
| Q6 | Is Bragi personal-use only, or intended to become a commercial product? This changes the licence constraints on models (non-commercial weights) and the legal review timing. | Before Phase 4 | Koen | Affects [04 §9](04-analysis-pipeline.md), [10 §7](10-fusion.md) |
| Q7 | Free tier size (credits/day) and whether there is a paid tier | WP-2.7 | Koen | Only matters if others use it |
| Q8 | UI font final choice | WP-0.6 | Agent | **Proposed in WP-0.6, awaiting the owner's sign-off: Geist (UI) + Geist Mono (times, BPM, values)**, both SIL OFL 1.1, self-hosted as `woff2` (latin + latin-ext) in `packages/design/fonts/` with the licence next to them — no remote font loading (strict CSP, [01 §10](01-architecture.md)). Swapping either family is a token change (`font.sans` / `font.mono` in `packages/design/tokens.json`) plus a file swap in `packages/design/fonts/`; `pnpm --filter @bragi/design tokens:report` prints the scale. |
| Q9 | Should the desktop app support a fully offline "local compute" mode in v1 (bundled Python sidecar) or only bring-your-own-backend? | WP-6.7 | Koen | Spec currently says BYO backend only ([05 §10](05-backend-and-jobs.md)) |
| Q10 | Demo songs for onboarding: commission, self-produce, or generate with Bragi itself? | WP-6.3 | Koen | Must be licence-clean |
| Q11 | With hosted CI dropped (solo project, 2026-10-18), how is cross-platform behaviour actually verified? The engine, the webviews and the desktop build must work on macOS, Windows and Linux ([01 §3](01-architecture.md)), and `pnpm verify` only ever runs on one machine at a time. Options: run the sweep manually per OS before a milestone, a VM/boot-camp pass, or re-enable the dormant workflow for the cross-OS jobs only. | WP-0.5 (first cross-platform claim), WP-1.1 (engine parity) | Koen | The workflow in `.github/workflows/ci.yml` is kept correct for this reason. See [13 §6](13-agent-guide.md). **WP-0.5 update (2026-10-18):** its e2e ran on macOS 15 / arm64 only — Chromium, Firefox and Playwright WebKit (the WebKit engine Safari uses, *not* Safari), plus the Tauri app via the `selftest` build. **Unverified and not claimed:** Tauri on Windows and Linux (the `desktop-e2e-linux` / `desktop-e2e-windows` jobs have never run) and the Safari browser itself. |
| Q12 | What is the shape of `analysis.apply`'s `effects[]`? WP-0.2 typed it as an array of free-form objects so the op exists and validates; the effects themselves (create this track, split there) are unspecified. | WP-1.8 | Agent | Schema: `packages/schemas/song/ops/analysis.apply.schema.json` |
| Q13 | What is the shape of `meta.suggestedSections` ([02 §6](02-song-model.md))? The conflict path for a late `structure` stage writes it, but no shape is defined, so it is not in the `Project` schema yet. | WP-1.8 | Agent | 02 §6 |
| Q14 | `section.duplicate`, `section.split` and `clip.split` name the new *section* or *clip* ID but not the IDs of the clips they copy or split into it. `apply` must be deterministic, so either the payload carries the derived IDs or the rule for deriving them is written down. | WP-0.3 | Agent | `packages/schemas/song/ops/section.*`, `clip.split` |
| Q15 | Canonical JSON for hashing: Rust and Python re-emit an integral `number` as `0.0` where the input said `0`. The acceptance criterion counts that as lossless (numbers compare numerically), so what exact bytes does the commit hash use, and does `canonical_json` normalise numbers? | WP-0.3 | Agent | `canonical_json`, the commit hash in 02 §2.1 |
| Q16 | 04 leaves several analysis blob shapes open: the hop and length of the short-term loudness series, the embedding window/hop and whether one blob holds one or many vectors, and the exact `drum_split`/`transcribe`/`lyrics` fields. WP-0.2 wrote a defensible shape for each; the producing stage must confirm it. | WP-1.2, WP-1.6 | Agent | `packages/schemas/analysis/` |
| Q17 | `packages/schemas/analysis/taxonomy.json` ([04 §6.2](04-analysis-pipeline.md)) — the controlled ~150-genre / ~60-mood / ~80-instrument / ~200-descriptor vocabulary — does not exist yet. The `tag` schema keeps labels as strings until it does. | WP-1.6 | Agent | 04 §6.2 |
| Q18 | `packages/schemas/src/generated/ajv-validators.js` is ~850 KB, because it embeds the whole schema graph and every compiled validator in one module (needed to share the `$defs`). Is that acceptable for the web bundle, or should WP-0.5 split it per root type and accept duplicated `$defs`? | WP-0.5 | Agent | [ADR-0006](decisions/ADR-0006-schema-codegen.md) |
| Q23 | Who owns the retry count for a failed job? 05 §4.3 says the orchestrator does, but it does not increment `JobRequest.attempt` yet, so WP-0.7's worker caps retries from JetStream's own delivery counter (`Settings.max_attempts`). Decide whether the orchestrator re-publishes with `attempt + 1` or the worker keeps a cap. | WP-1.2 (first real capability) | Koen | 05 §4.3, `bragi_common.worker` |
| Q24 | Where do OpenTelemetry traces go outside local dev? WP-0.7 ships a Jaeger all-in-one for local viewing plus an in-test OTLP receiver; staging/prod need a decision (self-hosted collector + storage vs. a vendor). | WP-6.9 (with staging) | Koen | 05 §11 |
| Q25 | On WebSocket reconnect, the client re-subscribes and re-fetches `GET /jobs/{id}` (05 §3), but intermediate events are lost. Is a replay from the `EVENTS` stream (by sequence) worth it, or is the REST re-fetch enough? | WP-1.10 | Agent | 05 §3, §4.1 |

## Resolved

| # | Question | Answer | Reference |
|---|---|---|---|
| R1 | Tech stack | Tauri 2 + TS/React + Rust core (WASM/native) + Python GPU services | [ADR-0001](decisions/ADR-0001-tech-stack.md) |
| R2 | Which time-stretch library? | The pure-Rust phase vocoder in `bragi-dsp::stretch` is the shipped implementation (portable, allocation-free, exact pass-through). Signalsmith Stretch is evaluated and held for offline renders; Rubber Band is rejected on licence. The `Render`-tier recommendation is provisional until the owner's listening check. | [ADR-0002](decisions/ADR-0002-time-stretch.md) |

## Resolved by WP-0.3

Appended rather than folded into the tables above, so parallel work packages never edit the same
rows.

| # | Question | Answer | Reference |
|---|---|---|---|
| Q14 | Derived clip/fx IDs for `section.duplicate`, `section.split`, `region.clear` | Deterministic: `clp_`/`fx_` + the first 26 chars of the base32 SHA-256 of `derive:<parentId>:<originalId>`. Recorded in [02 §4.2](02-song-model.md); implemented in `crates/bragi-model/src/canonical.rs` (`derived_id`) and covered by `crates/bragi-model/tests/ops.rs`. | [02 §4.2](02-song-model.md), [`docs/wp/0.3.md`](../docs/wp/0.3.md) |
| Q15 | Canonical JSON and number normalisation | `canonical_json` sorts keys and writes an integral `number` without a fractional part (`0`, not `0.0`), so map iteration order and `0` vs `0.0` never change the bytes. The commit hash is taken over that output. | [02 §2.1](02-song-model.md), `crates/bragi-model/src/canonical.rs` |

## Open after WP-0.4

| # | Question | Needed by | Owner | Notes |
|---|---|---|---|---|
| Q19 | After the ±12 % drum listening check, is the vocoder's transient smearing acceptable, or should offline `Render` adopt Signalsmith Stretch (or a smaller `Render` FFT)? | WP-0.4 follow-up / WP-1.1 | Koen | Decided by [0.4-MANUAL_CHECKS](../docs/wp/0.4-MANUAL_CHECKS.md). ADR-0002 stays Proposed until answered. |
| Q20 | If Signalsmith is adopted, do we carry its `wasm32` toolchain (wasi-sdk + 7 libc++ shims) in `pnpm verify`, or keep it native-only and use the vocoder in the browser? | WP-1.1 | Koen | Toolchain details in [ADR-0002](decisions/ADR-0002-time-stretch.md). |

## Added by WP-1.1

| # | Question | Needed by | Owner | Notes |
|---|---|---|---|---|
| Q26 | Master metering: momentary LUFS and the 64-band spectrum (03 §10). WP-1.1 ships per-track peak/RMS and master peak/RMS in the fixed-word state block; K-weighting + FFT are not done. Which work package owns the full master meter, and at what update rate? | WP-1.9 (canvas visuals) | Agent | [03 §10](03-audio-engine.md), `crates/bragi-engine/src/meters.rs` |
| Q27 | When the output device refuses 48 kHz (03 §7 assumes the project rate), does the engine resample on output, does the host, or does playback refuse? WP-1.1's cpal host refuses and says so. | WP-1.9 / WP-1.11 | Koen | [02 §2.2](02-song-model.md), `crates/bragi-engine-native/src/output.rs` |
| Q28 | Does the browser compile render plans on the main thread and ship them to the AudioWorklet, or does the worklet compile them itself from the document? WP-1.1 ships the worklet-side path (decode + `load_project` in the worklet), which is simpler but puts plan compilation off the 128-frame budget. | WP-1.9 | Agent | [03 §3.1, §4](03-audio-engine.md) |
| Q29 | `Warp::Stretch.ratio` has **two readings**: 03 §7 says time ratio = output/input (`> 1` is longer), while `bragi_model::clipmath` computes `duration = (srcEnd − srcStart)/ratio` (i.e. `> 1` is shorter). WP-1.1 derives the segment ratio from the resolved destination window, so playback follows the model, but the spec and the model must be reconciled — and reverse + stretch/pitch is unimplemented until they are. | WP-2.2 (resize `stretch`) | Agent | [03 §7](03-audio-engine.md), [02 §3.6](02-song-model.md), `crates/bragi-model/src/clipmath.rs` |
| Q30 | The master limiter is zero-latency (instant attack, 50 ms release, hard ceiling) rather than the 5 ms look-ahead / true-peak of 03 §6, because a look-ahead delay needs a pre-roll in every offline render. Keep it, or implement the delay + pre-roll? | WP-1.11 (export) | Agent | [03 §6](03-audio-engine.md), `crates/bragi-engine/src/render.rs` |
| Q31 | WASM-vs-native: the engine's own paths null at ≤ −90 dBFS, but a **phase-vocoder** fixture nulls at ≈ −69 dBFS because libm trig (`sin`/`cos`/`atan2`) differs in the last bits between native and wasm32 and the vocoder accumulates phase. Fix by using deterministic f32 math in `bragi-dsp` (owner: WP-0.4 follow-up), or accept and keep the fixture informational? | WP-0.4 follow-up | Koen | [ADR-0002](decisions/ADR-0002-time-stretch.md), `scripts/conformance.mjs` |

## Added by WP-0.3

| # | Question | Needed by | Owner | Notes |
|---|---|---|---|---|
| Q21 | `section.move` cannot express "smooth the transitions" (02 §5.1 says the moved section and its successor become a 1-beat `crossfade` *if smoothing is requested*, but the op payload has no flag). Should the planner/UI add a flag, make smoothing unconditional, or drop 02 §5.1's rule? WP-0.3 leaves transitions alone and only re-anchors master automation. | WP-1.8 (planner) | Agent | [02 §5.1](02-song-model.md), `packages/schemas/song/ops/section.move.schema.json` |
| Q22 | `crates/bragi-dsp/fx_catalog.json` (03 §6) did not exist; WP-0.3 created it so `validate` can enforce invariant 5 (FX param ranges). WP-0.4/1.1 own `bragi-dsp` and may extend it (non-numeric params such as `sidechain_duck.sourceTrack`, `match_eq.bands` are in the file but not yet validated, because `FxParams` only holds numbers). Confirm the ranges and the missing structural validation. | WP-0.4 / WP-1.1 | Agent | [03 §6](03-audio-engine.md), `crates/bragi-dsp/fx_catalog.json` |

## Added by WP-1.2

| # | Question | Needed by | Owner | Notes |
|---|---|---|---|---|
| Q32 | **The eval set does not exist.** WP-1.2 ships the manifest format, `scripts/fetch-eval.sh` and the harness, but `fixtures/eval/manifest.json` has no tracks, so the rhythm gate (beat F ≥ 0.85) is `PENDING` and nothing about Beat This!'s accuracy on real music is known. Who supplies the ~50 labelled tracks (audio into a private bucket; hand-labelled beats/downbeats as `.beats` files in `fixtures/eval/labels/`), and where is the bucket? | before WP-1.4 (its gates need the same set) | Koen | `fixtures/eval/README.md`, 04 §8 |
| Q33 | The orchestrator passes the *uploaded* asset hash as `assets.source` to every stage (`services/api/src/orchestrator/handler.ts`), so `rhythm` and `loudness_energy` decode the original upload, not the `ingest` working asset, and `ingest`'s `workingAsset` output is never fed forward. The decode paths are identical in effect, but 04 §1.4 says times are in seconds *of the working asset*. Should the orchestrator pass `workingAsset` to downstream stages, and should it also record each capability's `stageVersion` (the workers know it: `rhythm@beat_this-final0-1`, but `JobEvent.metrics` is not populated yet)? | WP-1.10 | Agent | `bragi_analysis.trackers`, 04 §1.5, 05 §4.2 |
| Q34 | Beat This! code and weights are MIT, but its README notes that some *training* files are copyrighted or under limited CC licences. Is that acceptable for a commercial launch, or should it be treated as unclear until legal review? (Tied to Q6.) | before any commercial launch | Koen | `services/workers/MODELS.md`, ADR-0007 |
| Q35 | `timeSignature.denominator` is always 4: beat positions cannot separate 6/8 from 3/4 or 12/8 from 4/4. Add a compound-meter heuristic (beat-subdivision analysis) in `rhythm`, or defer to `structure`/`harmony` evidence? | WP-1.4 | Agent | `bragi_analysis.rhythm_post.time_signature` |
| Q36 | Q23 (who owns the retry count) is still open: WP-1.2 added `JobFailure(code, message, retryable)` so deterministic rejections (corrupt, too long) are acked immediately instead of being redelivered, but crashes still retry from JetStream's delivery counter. | WP-1.10 | Koen | `bragi_common.errors`, `bragi_common.worker` |

## Resolved by WP-1.2

| # | Question | Answer | Reference |
|---|---|---|---|
| Q16 (part) | Hop and length of the short-term loudness series | Hop 0.5 s, `ceil(durationSec / 0.5)` entries, each a 3 s window centred on the hop (edge-truncated), floored at −70 LUFS; the energy curve has the same length. The embedding and `drum_split`/`transcribe`/`lyrics` parts stay open for WP-1.6. | [04 §5.5](04-analysis-pipeline.md), [`docs/wp/1.2.md`](../docs/wp/1.2.md) |

## Resolved by WP-1.8

Appended rather than folded into the tables above, so parallel work packages never edit the same
rows.

| # | Question | Answer | Reference |
|---|---|---|---|
| Q12 | Shape of `analysis.apply`'s `effects[]` | A list of **tagged facts**, at most one per kind, each owned by exactly one stage: `tempo` (rhythm), `sections` (structure), `separation` (separation), `tags` (tag), `description` (describe); every other stage sends `[]`. The op also records the merged list in the new `AnalysisRef.effects`, because `bragi-model` cannot read blobs and the arrangement is rebuilt from the *set* of recorded effects — which is what makes stage arrival order-independent. An effect/stage mismatch or a duplicate kind is rejected with the new `analysis_effects` code. | [02 §6](02-song-model.md), [`packages/schemas/song/analysis-ref.schema.json`](../packages/schemas/song/analysis-ref.schema.json), [`docs/wp/1.8.md`](../docs/wp/1.8.md) |
| Q13 | Shape of `meta.suggestedSections` | `SectionSuggestion[]`, each `{ sourceId, startSec, endSec, startTick, endTick, kind, label, confidence?, repeatGroup? }`: the analysis truth in seconds plus the same span on the arrangement's tick grid for the canvas. Written by the conflict path of a late `structure`, replaced wholesale per source, cleared by a pristine `structure` or by `project.set_meta` with an empty list. | [02 §6.3](02-song-model.md), [`packages/schemas/song/project.schema.json`](../packages/schemas/song/project.schema.json) |

## Added by WP-1.8

| # | Question | Needed by | Owner | Notes |
|---|---|---|---|---|
| Q26 | `AnalysisRef.summary` (`bpm`, `key`, `durationSec`, `genres`, `moods`) is not written by `analysis.apply`: `key` is not among the typed effects, and the model cannot read the `harmony` blob. Should a `harmony` effect kind carry the key (and a `summary` be derived once all five parts are known), or does the API/job flow write `summary` from the blobs directly? Until then `summary` stays absent and the canvas gets bpm and duration from the tempo effect and the source. | WP-1.10 | Agent | [02 §3.3](02-song-model.md), [02 §6](02-song-model.md) |

## Added by WP-1.11

| # | Question | Needed by | Owner | Notes |
|---|---|---|---|---|
| Q37 | MP3 export and `normalize` (`lufs`/`truePeakDb`) are in the 03 §9 types but not in WP-1.11's roadmap scope (WAV/FLAC). Which work package owns an MP3 encoder (licence-clean, WASM-capable; candidate pure-Rust crates need a licence check and an ADR) and BS.1770 loudness measurement + true-peak limiting (which also unblocks Q26)? Hosts currently reject both with a typed error. | Before any "share"/publish flow | Koen | [03 §9](03-audio-engine.md), `crates/bragi-engine/src/export/mod.rs` |
| Q38 | The master safety limiter (-0.3 dBFS, 03 §6) applies to every mixdown, including float exports, so "an unedited project nulls against the working asset" holds only for assets that peak below the ceiling. Loud working assets (peaks above -0.3 dBFS) are limited on export. Keep (spec: the user cannot remove it), bypass it for 32-bit float exports, or normalise working assets on ingest to leave headroom? | WP-1.10 / ingest | Koen | [03 §6](03-audio-engine.md), [04 §3.1](04-analysis-pipeline.md), `docs/wp/1.11.md` |
| Q39 | Export progress, cancellation and non-blocking: `EngineService::export` runs inside the Tauri command while the service mutex is held, so a long export blocks `engine_state` polling and transport commands, and neither host reports progress. Needs a job handle (start/progress/cancel) and either a cloned plan + PCM handle or a separate export worker. | WP-1.10 (export UI) | Agent | `apps/desktop/src-tauri/src/engine.rs`, `packages/platform/src/web/engine.worker.ts` |
## Added by WP-1.3

| # | Question | Needed by | Owner | Notes |
|---|---|---|---|---|
| Q40 | The HTDemucs weights carry no separate licence (the Hugging Face repos have no `license` field; upstream says only "Demucs is released under the MIT license"), and were trained on MUSDB18-HQ (non-commercial research licence) plus an undocumented 800-song set. Are they acceptable for a commercial launch, or must they be replaced? | Before any commercial launch (Q6) | Koen | [MODELS.md](../services/workers/MODELS.md), [ADR-0004](decisions/ADR-0004-separation-model.md) |
| Q41 | `demucs` pulls in `lameenc` (LGPL-3.0-or-later) although the worker never calls it. Keep it as a dynamically linked wheel, or vendor only the network code (drops `lameenc`, `sphn`, `julius`)? | WP-6.x (release) | Agent | [MODELS.md](../services/workers/MODELS.md) |
| Q42 | Run the real separation bake-off on the owner's eval set (htdemucs_6s vs htdemucs vs htdemucs_ft vs a loading RoFormer vocal checkpoint), measure a 4-min song on the reference GPU, and move ADR-0004 to Accepted. | After WP-1.2 supplies the eval set | Koen + Agent | [ADR-0004](decisions/ADR-0004-separation-model.md) |
| Q43 | The CUDA-bundled Linux torch wheel makes the worker image multi-GB; is a CPU-only image (torch index override) wanted for the `worker` compose service? The compose image build with `--group models` was not run (Docker Hub blocked in the sandbox). | WP-1.10 | Agent | `services/workers/Dockerfile` |

## Added by WP-1.9

| # | Question | Needed by | Owner | Notes |
|---|---|---|---|---|
| Q50 | 07 §9 asks for MSDF bitmap fonts. WP-1.9 draws labels with Pixi `Text` (canvas-rasterised at the device pixel ratio, pooled). Is that good enough at every zoom and at 200 % text, or do we want an MSDF atlas generated from Geist (a build step and a licence check of the atlas)? | WP-1.10 polish | Owner | Labels are not scaled with zoom (they are re-placed, not re-rasterised), so the crispness argument for MSDF is weaker than in a zooming scene. |
| Q51 | 07 §9 puts ribbon timbre in a shader uniform. WP-1.9 bakes brightness and noisiness into a 3-row texture per ribbon mesh and uses the stock mesh shader, so one code path serves WebGL2 and WebGPU without hand-written GLSL + WGSL. Keep, or write the two shaders when grain should be per-pixel? | WP-2.x | Owner | Grain is currently a deterministic vertex jitter. |
| Q52 | The web worklet decodes assets (`add_asset`) on the audio thread when a project is loaded, not in the decoder worker (03 §3.1). Fine for the 12 MB demo before play; a large project would glitch other tabs' audio if loaded during playback. Move decoding to the worker and ship PCM to the worklet over a SAB? | WP-1.10 | Owner | Ties to Q28. `docs/wp/1.9.md`. |
| Q53 | Visual goldens are macOS (Metal) Chromium goldens, and the `chromium-webgpu` flags for Linux are written but unrun. 13 §6 wants the visual run on Linux. Generate Linux goldens when a Linux machine is available? | Owner's call | Owner | Same hosted-CI caveat as Q11. |
| Q54 | 07 §9 budgets name "a 2020-era integrated GPU". WP-1.9 measured on an Apple-silicon GPU, and only CPU render time and rAF cadence (no GPU timestamp queries). Is that evidence enough, or should a Windows/Intel run be added? | M1 sign-off | Owner | Numbers in `docs/wp/1.9.md`. |
| Q55 | The document has no repeat-group field (only `meta.suggestedSections[].repeatGroup`). The canvas derives groups from kind plus label without a trailing number, and from `derivedFrom`. Should `SectionInstance` carry a stored `repeatGroup` from analysis (02 §3.5)? | WP-1.10 | Owner | `features/song/api/view-model.ts` `repeatGroups`. |
| Q56 | The beat grid and "bars" use the first time signature only, and denominators other than 4 are treated as `ppq * 4 / denominator` ticks per beat. Mixed or changing meters need their own handling (02 §2.2 `bar_beat_to_ticks`). | Later WP | Owner | Fine for the v1 analysis, which yields one meter. |
| Q57 | Energy, chords and per-ribbon RMS/brightness/noisiness have no consumer of the analysis *blobs* yet; the demo feeds `AnalysisView` from a synthetic generator. WP-1.10 must map the 04 §6 result blobs onto `AnalysisView` (types in `packages/render-canvas/src/types.ts`) and decide where the peak pyramid (03 §10) replaces the synthetic `peaks` callback. | WP-1.10 | Owner | |
| Q58 | WP-0.5's Playwright config left `browserName` unset, so its "firefox" projects ran Chromium. WP-1.9 fixed the config. Its Firefox claim for WP-0.5 (platform e2e) was therefore never a Firefox result; see the re-run recorded in `docs/wp/1.9.md`. | Owner awareness | Owner | |
| Q59 | `pnpm typecheck` (`tsc -b` over root project references + `tsc -p tsconfig.test.json`) does not include `apps/web` or `apps/desktop`, so a type error in `apps/web/e2e/**` passes `pnpm typecheck` and only surfaces through `pnpm build`/`pnpm test` (turbo `test` depends on `build`). WP-1.9 hit this: a duplicate object key (TS2783) in `canvas-perf.spec.ts` passed `typecheck` and failed `web#build`. Should the root typecheck reference the apps, or is the build dependency the intended gate? | Owner | Agent | |
| Q60 | The 07 §9 budget numbers are written by `canvas-perf.spec.ts` to `apps/web/test-results/*.json`, which is gitignored and deleted by the next Playwright invocation (output-dir cleanup). Only the prose in `docs/wp/1.9.md` survives. Should budget runs write a durable artifact to `reports/` instead? | Owner | Agent | Ties to Q53/Q54. |

## Added by WP-1.4

| # | Question | Needed by | Owner | Notes |
|---|---|---|---|---|
| Q44 | Upgrade the weight-free `structure` segmenter+labeller to a neural All-In-One-class model (or another), which 04 §5.2 names as the v1 option. Blocked on a **weights-licence-clear** checkpoint and the eval set; the model must speak the same `intro verse chorus …` vocabulary so grouping, snapping and the contract are untouched. | after the eval set exists (Q32) / WP-1.4 follow-up | Koen + Agent | [ADR-0010](decisions/ADR-0010-structure-segmentation.md), [04 §5.2](04-analysis-pipeline.md) |
| Q45 | The `repeatGroup` grouping threshold (`SAME_MATERIAL = 0.65` in `structure/grouping.py`) and the label energy tie are **untuned on real music** (there is no eval set). Calibrate them, and the boundary/`repeatGroup` gates, once `fixtures/eval` has sections. | WP-1.4 follow-up / WP-1.6 | Agent | `services/workers/analysis/src/bragi_analysis/structure/grouping.py`, [04 §8](04-analysis-pipeline.md) |
| Q46 | 04 §5.2 says the model-vocabulary → `SectionKind` mapping lives in `packages/schemas/analysis/taxonomy.json`, which WP-1.6 has not created yet (that file is the ~150-genre *tag* taxonomy). Until then the mapping is `bragi_analysis/config/structure_labels.json`. Decide the final home (one file for both, or a `sections.json` next to it) when WP-1.6 lands. | WP-1.6 | Agent | [04 §5.2, §6.2](04-analysis-pipeline.md), `services/workers/analysis/src/bragi_analysis/config/structure_labels.json` |
| Q47 | A **silent lead-in** plus a **fallback** beat grid splits off an extra section: the DSP tracker places a spurious beat at t ≈ 0 in the lead-in silence and the segmenter segments there (synthetic `song_pop_100bpm_leadin`, 9/8 sections, label accuracy 0.500, chorus grouping False). It does not appear with the exact grid or the skipped boundaries. Should `structure` trim leading/trailing silence before segmenting, should the tracker's grid be robust to a silent head, and does the v1 tracker (Beat This!) show it on real music? | WP-1.4 follow-up / WP-1.10 | Agent | `structure/pipeline.py`, `docs/wp/1.4.md` |

## Added by WP-1.5

| # | Question | Needed by | Owner | Notes |
|---|---|---|---|---|
| Q61 | 04 §5.3 derives `progressionFingerprint` **per section**, but `harmony` depends only on `separation` in the DAG, so `structure` may never run (the `quick` profile). When there are no sections, WP-1.5 publishes one whole-song progression at `index: 0`. Is that acceptable, or should `sections` be omitted entirely until `structure` exists? | WP-1.7 / WP-1.10 | Agent | `HarmonyResult.sections`, `bragi_analysis.harmony.pipeline` |
| Q62 | `progressionFingerprint` is described as a "normalised roman-numeral **n-gram** sequence" but the example (`i-VI-III-VII`) is a plain 1-gram sequence. WP-1.5 ships the collapsed 1-gram sequence (immediate repeats removed). Does the constellations similarity ([08 §5](08-universe.md)) want true n-grams (e.g. a sorted set of bigrams) instead, which would change the stored string? | WP-3.5 | Agent | 04 §5.3, `bragi_analysis.harmony.key.fingerprint` |
| Q63 | 04 §5.3 wants **beat-synchronous** chroma, but beats come from `rhythm`, a sibling of `harmony` (both depend on `separation`), and the orchestrator passes only `assets.source` (Q33). WP-1.5 uses a `rhythm` blob when one is in `inputs.blobs` and the frame grid otherwise. Should the DAG/orchestrator feed `rhythm` (and `structure`) to `harmony` as blobs? | WP-1.10 | Agent | 04 §2, `bragi_analysis.capabilities.harmony` |
| Q64 | Which (if any) neural chord recogniser should replace the weight-free template decoder, and does the ≥ 0.70 majmin gate need it? Candidates have unclear/non-commercial weight licences (madmom is CC BY-NC-SA; BTC and others need verification); slash chords (`C/E`) and extended tensions are out of scope until then. | before the eval-set bake-off | Koen + Agent | [ADR-0008](decisions/ADR-0008-chord-detection.md), [MODELS.md](../services/workers/MODELS.md) |
| Q65 | The WP-1.2 eval harness scores `rhythm` only. Scoring the harmony gate needs `mir_eval.chord` (majmin) plus a key-accuracy count and chord/key labels in `fixtures/eval/manifest.json`. Who extends the harness and the manifest schema, and in what format are chord intervals and keys labelled? | before WP-1.5's gate can run | Agent | 04 §8, `bragi_analysis.evaluation` |
