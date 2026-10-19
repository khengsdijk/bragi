# ADR-0006 — Schema codegen: one JSON Schema set, three generated type systems

- **Status:** Accepted
- **Date:** 2026-10-18
- **Decider:** Koen
- **Work package:** WP-0.2

## Context

[01 §7](../01-architecture.md) makes JSON Schema (2020-12) in `packages/schemas` the source of truth
for every cross-language contract: the song document and its ops, the analysis result blobs, the job
envelopes and the API error codes. TypeScript (the UI), Rust (`bragi-model`, the engine) and Python
(the workers) all have to agree on those contracts, and they have to *keep* agreeing as the schemas
change. Nobody is going to hand-write the same type three times and keep it in sync.

Two hard constraints shape the choice:

1. **The UI runs under a strict CSP** ([01 §10](../01-architecture.md)) with no remote script
   loading, so it cannot compile JSON Schemas at runtime: Ajv's `new Function` code generation is
   not available in the browser. Validators must be precompiled ahead of time.
2. **Generated code is never hand-edited** ([13 §1](../13-agent-guide.md)), which means the
   generators' output is a build artifact that must be deterministic, checked in, and verified
   against the schemas by the build (`pnpm schemas:check`).

[01 §1](../01-architecture.md) already names JSON Schema → TypeScript + Ajv, Rust via `typify` and
Python Pydantic v2 as the intended pipeline; what it does not settle is *which* generators implement
it, how their outputs are kept consistent with each other, and how the result is checked.

## Options considered

| # | Option | Verdict |
|---|---|---|
| 1 | **Typify (Rust) + `json-schema-to-typescript` + Ajv standalone (TS) + `datamodel-code-generator` (Python)** | **Chosen** |
| 2 | Hand-write the three type sets, generate only the schemas | Rejected: three sources of truth that drift silently, which is exactly what 01 §7 forbids |
| 3 | Generate Rust from the TS types (`ts-rs`) or the reverse | Rejected: whichever language generates first becomes the real source of truth, and neither can express every JSON Schema constraint |
| 4 | A runtime (non-precompiled) Ajv validator in the UI | Rejected: blocked by the CSP; `new Function` is exactly what a strict CSP forbids |
| 5 | One generator (e.g. JSON-Schema-to-Zod + zod-to-everything) | Rejected: weak or missing Rust and Python back ends, and Zod would become a *fourth* contract language |
| 6 | `quicktype` for all three languages | Rejected: no Pydantic v2 models, and its Rust output is not `serde`-shaped to our needs; also unmaintained for 2020-12 |

## Decision

Pipeline: `packages/schemas/codegen/gen.mjs` (`pnpm schemas:gen`) bundles every
`song|analysis|jobs|api/**/*.schema.json` into one 2020-12 document and drives three generators from
that single artifact:

| Language | Generator | Output | Deps |
|---|---|---|---|
| TypeScript types | `json-schema-to-typescript` | `packages/schemas/src/generated/types.ts` | `json-schema-to-typescript` (**dev**) |
| TypeScript validators | Ajv 2020-12, standalone (precompiled) | `packages/schemas/src/generated/ajv-validators.js` + a typed façade | `ajv` (**runtime**: the precompiled module imports Ajv's CommonJS `ucs2length` helper) |
| Rust | `typify` **0.8**, driven by `crates/bragi-schemas-codegen` | `crates/bragi-model/src/generated/mod.rs` | `typify`, `schemars` 0.8, `syn`, `prettyplease` (**codegen binary only**); `serde`, `serde_json`, `regress` (**runtime** in `bragi-model`) |
| Python | `datamodel-code-generator` → Pydantic v2 | `services/workers/bragi_common/src/bragi_common/generated/models.py` | `datamodel-code-generator` (**dev**); `pydantic` (**runtime**) |

Supporting decisions, each forced by "the three generators must name things identically and none of
them may silently change a value":

- **The bundle is the single input.** Every generator reads `generated/bundle.schema.json`, so a type
  has one name everywhere. `gen.mjs` enforces the authoring conventions that make that possible —
  a `title` on every named type, no inline object or multi-value enum, `oneOf` only with `$ref`
  branches, no `format`, no `\d` and no look-around in patterns, `additionalProperties` on every
  object, and a named `$def` for every optional array or map (a collection typify would otherwise
  drop when empty). It also *lifts every inline single-value enum* — an op's `"op"` discriminator —
  into a `$def` named `<Owner><Property>`, which is the name typify invents on its own and the only
  way the other two can be made to match.
- **Validators are precompiled** (CSP, above). The output is one self-contained ES module: the gen
  step fails if Ajv emits a `require()`, because it would not load from an ES module in Node, Vite
  or the webview.
- **Timestamps are patterns, not `format`.** `format: date-time` would make one language parse an
  ISO string into a date type that re-formats it, which breaks losslessness; a `pattern` keeps the
  string byte for byte.
- **`--check` is the gate.** `pnpm schemas:check` regenerates everything in memory (Rust and Python
  into a temp directory) and fails, naming the stale files. It runs first in `pnpm verify` and in its
  own CI job.

## Consequences

**Positive**

- One place to change a contract: edit the schema, run `pnpm schemas:gen`, commit both.
- The acceptance criterion is executable in all three languages: the 02 §10 example document
  deserializes into the generated `Project` in TS, Rust and Python and round-trips losslessly.
- The UI ships no schema compiler, so the CSP stays strict.

**Negative / mitigations**

- *A large generated file.* `ajv-validators.js` embeds the whole schema graph and every compiled
  validator (~850 KB, unminified). Mitigation: it is generated once and served as a static asset;
  if bundle size ever matters, WP-0.5 can split it per root type (which would duplicate the shared
  `$defs`, so it is a trade-off to measure, not a free win).
- *Four codegen dependencies to track.* Mitigation: all are
  pinned, and `pnpm schemas:check` fails loudly when a generator's output changes, so an upgrade is
  visible in the diff.
- *Generated code cannot satisfy every lint.* `bragi-model/src/generated/mod.rs` carries
  `#![allow(unused_qualifications, missing_docs, clippy::unwrap_used, clippy::expect_used)]` in its
  generated header; `ajv-validators.js` and `bragi_common/generated/` are excluded from Biome and
  ruff respectively. The alternative — hand-maintaining generated code so it lints cleanly — is what
  13 §1 forbids.
- *Rust's typed model is not a validator.* `typify` checks types, enums, IDs, patterns, string
  lengths and integer bounds, but **not float bounds** (`pan`, `bpm`), which is why
  `fixtures/projects/invalid-cases.json` names the languages that must reject each case. Those
  invariants belong to `bragi-model::validate` (WP-0.3), which is where cross-object invariants live
  anyway.
- *`datamodel-code-generator`'s RootModel choice.* A `RootModel` subclass is unhashable, so a map
  keyed by a constrained string ID cannot be validated. Mitigation: the pipeline generates PEP 695
  `type` aliases (`--use-type-alias`), which are hashable and keep the type name; this is recorded in
  `gen.mjs` because it is easy to lose in a generator upgrade.

## Related decisions

- ADR-0001 (tech stack) names the pipeline; this ADR settles the tools and the conventions.
- ADR-0002 time-stretch library (WP-0.4), ADR-0003 event bus (WP-0.7), ADR-0004 generation models
  (WP-2.7), ADR-0005 GPU hosting (WP-6.9).
