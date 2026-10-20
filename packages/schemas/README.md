# @bragi/schemas

**JSON Schema (2020-12) is the source of truth for every cross-language contract in Bragi**
([01 §7](../../specs/01-architecture.md)). This package holds those schemas and the generated
TypeScript types and precompiled Ajv validators; the same schemas generate the Rust types in
[`bragi-model`](../../crates/bragi-model) and the Pydantic v2 models in
[`bragi_common`](../../services/workers/bragi_common).

The tooling decision is [ADR-0006](../../specs/decisions/ADR-0006-schema-codegen.md); the work
package is [WP-0.2](../../docs/wp/0.2.md).

## The rule

A new field, op, job capability or endpoint changes the schema **first**, then `pnpm schemas:gen`,
then the implementation. Generated code lives in `**/generated/**`, carries a "do not edit" header,
and is never hand-edited ([13 §1](../../specs/13-agent-guide.md)).

```
pnpm schemas:gen      # regenerate TS + Rust + Python from the schemas
pnpm schemas:check    # regenerate and fail if anything differs (runs first in `pnpm verify`)
```

`pnpm schemas:check` needs all three toolchains (pnpm, cargo, uv), because it regenerates all three
languages.

## Contents

| Path | Contract | Consumers |
|---|---|---|
| `song/*.schema.json` | Song document (`Project`), the entities it holds, and `Op`/`OpBatch`/`Commit`/`Refs` | TS, Rust, Python |
| `song/ops/<op>.schema.json` | One file per v1 op ([02 §4.2](../../specs/02-song-model.md)) | TS, Rust, Python |
| `analysis/*.schema.json` | Analysis result blobs and the section summary ([04](../../specs/04-analysis-pipeline.md)) | Python produces, TS/Rust consume |
| `jobs/*.schema.json` | `JobRequest` and `JobEvent` ([05 §4.2](../../specs/05-backend-and-jobs.md)) | API, workers |
| `api/errors.json` | The stable REST API error-code registry ([05 §2](../../specs/05-backend-and-jobs.md)) | API, `packages/api-client` |
| `api/error.schema.json` | The error envelope; its `ErrorCode` enum must equal `errors.json` | API, clients |
| `dsp/fx-catalog.schema.json` | `FxCatalog`, the shape of `crates/bragi-dsp/fx_catalog.json` ([03 §6](../../specs/03-audio-engine.md)) | TS, Rust, Python |
| `dsp/macros.schema.json` | `MacroCatalog`, the shape of `crates/bragi-dsp/macros.json` ([03 §6.1](../../specs/03-audio-engine.md)) | TS, Rust, Python |
| `examples/<RootType>.json` | One valid instance per root type, used by the contract tests in all three languages | TS, Rust, Python |
| `codegen/` | `bundle.mjs` (bundler + convention checks), `gen.mjs` (the pipeline) | `pnpm schemas:gen` |
| `generated/` | `bundle.schema.json`: every schema merged into one document with every `$ref` rewritten | the three generators |
| `src/generated/` | `types.ts`, `ajv-validators.js`, `validators.ts`, `fx-catalog.ts`, `macros.ts` | `@bragi/schemas` consumers |
| `sqlite/migrations/` | Local database migrations shared by web and desktop | WP-0.5 |

The generated Rust lives in `crates/bragi-model/src/generated/mod.rs`, driven by
`crates/bragi-schemas-codegen`; the generated Python lives in
`services/workers/bragi_common/src/bragi_common/generated/models.py`.

## Authoring conventions

All three generators read one bundle, so the schemas have to be written so that all three can name
and describe every type the same way. `codegen/bundle.mjs` **enforces** the list below and fails
`pnpm schemas:gen` with every violation it finds.

- **One root type per file**, with a PascalCase `title` — that title *is* the type name in all three
  languages. Shared types are `$defs` with globally unique names. A file whose root is not a value
  (like `song/common.schema.json`) is only a container of `$defs`.
- **No inline objects, unions or multi-value enums.** Each must be a file root or a `$def`, because
  typify and Pydantic otherwise invent a name that TypeScript will not match. Single-value enums (a
  discriminator like `"op": "track.add"`) may be inline: the bundler lifts each one into a `$def`
  named `<Owner><Property>` — the name typify invents on its own — so all three agree.
- **`additionalProperties` on every object**: `false` to reject unknown fields, a subschema for a
  typed map, `true` to stay deliberately open. A closed object is what makes the round trip lossless
  in a typed language: an unknown field is *rejected* rather than silently dropped.
- **A named `$def` for every optional array or map.** typify generates a collection that it skips
  when empty, so `"fx": []` on an optional property would be lost.
- **`oneOf` with `$ref` branches only**; no `anyOf` or `allOf` (they are not generated
  consistently).
- **No `format`.** A `format` makes one language parse a string into a richer type that re-formats
  it; use a `pattern` so the value survives as a string. That is why `IsoDate` is a pattern.
- **`enum: [x]`, never `const`** (typify only enforces the former).
- **Patterns use `[0-9]`, never `\d`** (Rust and Python match Unicode digits), and **no look-around**
  (Rust's `regress` and Python's `re` must both accept them).
- **Every `$def` is reachable from a file root.** An unreachable type would be emitted by one
  generator and dropped by another.

## Layout of the generated TypeScript

`src/index.ts` re-exports `src/generated/types.ts` and `src/generated/validators.ts`. The validators
are **precompiled** (Ajv's standalone output) rather than compiled from the schemas at runtime,
because the UI runs under a strict CSP where `new Function` is unavailable
([01 §10](../../specs/01-architecture.md)). `validators.ts` is a typed façade, so each validator is
`ValidateFunction<ItsType>` and a validator cannot disagree with its type:

```ts
import { validateProject, ROOT_TYPES, type Project } from "@bragi/schemas";

const value: unknown = JSON.parse(text);
if (!validateProject(value)) throw new Error(JSON.stringify(validateProject.errors));
const project: Project = value; // narrowed by the validator
```
