# bragi-model

The song model: document types, op application, validation, diff, time mapping and the commit
hash. **The only code in Bragi that changes a song document**
([02-song-model.md](../../specs/02-song-model.md), [13 §1](../../specs/13-agent-guide.md)).

Runs natively inside the engine and as WASM in every UI, through
[`packages/model-wasm`](../../packages/model-wasm) — one implementation, so web and desktop cannot
drift.

Public surface planned for **WP-0.3**: `apply` (all v1 ops except `analysis.apply` and
`region.adopt`), `validate` (every invariant in [02 §4.3](../../specs/02-song-model.md)),
`ticks_to_seconds` / `seconds_to_ticks` / `bar_beat_to_ticks` / `ticks_to_bar_beat`,
`section_spans`, `resolve_region`, `canonical_json`, the commit hash and
`diff(prev, next) -> EngineDelta`. `analysis.apply` follows in WP-1.8, `region.adopt` in WP-2.1.

`src/generated/mod.rs` holds the document and op types, generated from the JSON Schemas in
`packages/schemas` by `pnpm schemas:gen` (typify, driven by `crates/bragi-schemas-codegen`). Never
edit it: change the schema in `packages/schemas` and regenerate
([13 §1](../../specs/13-agent-guide.md)). `generated::ROOT_TYPES` lists every root schema type.
Note that the generated types are *not* a validator — typify does not range-check floats, so
cross-object and float-bound invariants live in `validate` (see
[ADR-0006](../../specs/decisions/ADR-0006-schema-codegen.md)).

Budgets: WASM bundle < 1.5 MB gzipped; `apply` of a 50-op batch on a 10-minute document < 5 ms;
10k-iteration proptest fuzzing with no panics.

**Status:** scaffold — the normative tick/sample-rate constants only.
