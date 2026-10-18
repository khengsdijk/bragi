# 15 — Open Questions

Questions that need an answer before or during a specific work package. Add new ones at the bottom. When one is resolved, move it to "Resolved" with the answer and a link (ADR or spec section).

| # | Question | Needed by | Owner | Notes |
|---|---|---|---|---|
| Q1 | Which time-stretch library? Signalsmith (WASM feasibility) vs pure-Rust vs Rubber Band (licence) | WP-0.4 | Koen | → ADR-0002 |
| Q2 | NATS JetStream vs Kafka. Is there any reason to align with Kafka early (familiarity, tooling)? | WP-0.7 | Koen | Contracts are broker-agnostic. Currently NATS. → ADR-0003 |
| Q3 | Which separation model(s) for v1, and are their weights licences acceptable? | WP-1.3 | Agent + Koen | Bake-off results |
| Q4 | Which generation model per capability (open weights vs hosted API), and their commercial terms | WP-2.7 | Koen | → ADR-0004 |
| Q5 | GPU hosting: serverless GPU platform vs AWS GPU instances | WP-6.9 (earlier for staging) | Koen | → ADR-0005 |
| Q6 | Is Bragi personal-use only, or intended to become a commercial product? This changes the licence constraints on models (non-commercial weights) and the legal review timing. | Before Phase 4 | Koen | Affects [04 §9](04-analysis-pipeline.md), [10 §7](10-fusion.md) |
| Q7 | Free tier size (credits/day) and whether there is a paid tier | WP-2.7 | Koen | Only matters if others use it |
| Q8 | UI font final choice | WP-0.6 | Agent | Open licence required |
| Q9 | Should the desktop app support a fully offline "local compute" mode in v1 (bundled Python sidecar) or only bring-your-own-backend? | WP-6.7 | Koen | Spec currently says BYO backend only ([05 §10](05-backend-and-jobs.md)) |
| Q10 | Demo songs for onboarding: commission, self-produce, or generate with Bragi itself? | WP-6.3 | Koen | Must be licence-clean |

## Resolved

| # | Question | Answer | Reference |
|---|---|---|---|
| R1 | Tech stack | Tauri 2 + TS/React + Rust core (WASM/native) + Python GPU services | [ADR-0001](decisions/ADR-0001-tech-stack.md) |
