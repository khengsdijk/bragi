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

## Resolved

| # | Question | Answer | Reference |
|---|---|---|---|
| R1 | Tech stack | Tauri 2 + TS/React + Rust core (WASM/native) + Python GPU services | [ADR-0001](decisions/ADR-0001-tech-stack.md) |
| R2 | Which time-stretch library? | The pure-Rust phase vocoder in `bragi-dsp::stretch` is the shipped implementation (portable, allocation-free, exact pass-through). Signalsmith Stretch is evaluated and held for offline renders; Rubber Band is rejected on licence. The `Render`-tier recommendation is provisional until the owner's listening check. | [ADR-0002](decisions/ADR-0002-time-stretch.md) |

## Open after WP-0.4

| # | Question | Needed by | Owner | Notes |
|---|---|---|---|---|
| Q19 | After the ±12 % drum listening check, is the vocoder's transient smearing acceptable, or should offline `Render` adopt Signalsmith Stretch (or a smaller `Render` FFT)? | WP-0.4 follow-up / WP-1.1 | Koen | Decided by [0.4-MANUAL_CHECKS](../docs/wp/0.4-MANUAL_CHECKS.md). ADR-0002 stays Proposed until answered. |
| Q20 | If Signalsmith is adopted, do we carry its `wasm32` toolchain (wasi-sdk + 7 libc++ shims) in `pnpm verify`, or keep it native-only and use the vocoder in the browser? | WP-1.1 | Koen | Toolchain details in [ADR-0002](decisions/ADR-0002-time-stretch.md). |
