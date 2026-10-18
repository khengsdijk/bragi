# bragi-common

The worker framework. Everything a capability should not have to reimplement: the NATS JetStream
client and job protocol, the result cache, S3 input/output, progress reporting, cancellation, and
the Pydantic v2 models generated from [`packages/schemas`](../../../packages/schemas)
([05-backend-and-jobs.md](../../../specs/05-backend-and-jobs.md)).

Held to `mypy --strict` without exception ([13 §3](../../../specs/13-agent-guide.md)).

`src/bragi_common/generated/models.py` holds the Pydantic v2 models for every cross-language
contract, generated from the JSON Schemas in [`packages/schemas`](../../../packages/schemas) by
`pnpm schemas:gen` ([ADR-0006](../../../specs/decisions/ADR-0006-schema-codegen.md)). Never edit it:
change the schema and regenerate. `generated.models.ROOT_TYPES` lists every root schema type, and
`generated.models` also holds the TypeScript-matching type aliases. The directory is excluded from
ruff (the field names deliberately mirror the JSON), but `mypy --strict` still checks it.

**Status:** scaffold plus the generated models (WP-0.2). Built by **WP-0.7**, whose acceptance is an
integration test that logs in, uploads a file, submits an `echo` job, receives `progress` and
`completed` over WebSocket, and produces one trace spanning API → NATS → worker.
