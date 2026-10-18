# @bragi/schemas

**JSON Schema (2020-12) is the source of truth for every cross-language contract in Bragi**
([01 §7](../../specs/01-architecture.md)). This package holds the schemas and the TypeScript types
and Ajv validators generated from them; the same schemas generate Rust types (via `typify`, into
`bragi-model`) and Python Pydantic v2 models (into `bragi_common`).

Planned contents:

| Path | Contract | Consumers |
|---|---|---|
| `song/*.schema.json` | Song document + all v1 ops | TS, Rust, Python |
| `analysis/*.schema.json` | Analysis result blobs | Python produces, TS/Rust consume |
| `jobs/*.schema.json` | Job and event envelopes | API, workers |
| `sqlite/migrations/` | Local database migrations shared by web and desktop | WP-0.5 |

**The rule:** a new field, op, job capability or endpoint changes the schema **first**, then
`pnpm schemas:gen`, then the implementation. Generated code lives in `**/generated/**` and is never
hand-edited ([13 §1](../../specs/13-agent-guide.md)).

**Status:** scaffold only — the source file is a placeholder identity constant. Filled by **WP-0.2**,
whose acceptance is that the example document in [02 §10](../../specs/02-song-model.md) validates in
all three languages and round-trips losslessly.
