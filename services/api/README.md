# @bragi/api

The Fastify API ([05-backend-and-jobs.md](../../specs/05-backend-and-jobs.md)): auth, projects,
sync (commits), assets (presigned S3 URLs), jobs, search, the AI planner module and the WebSocket
gateway.

Notes:

- Configuration comes from environment variables and is validated at boot with zod. No secrets in
  the repo ([01 §8](../../specs/01-architecture.md)).
- Route schemas are the source of the OpenAPI 3.1 document that generates
  [`@bragi/api-client`](../../packages/api-client).
- **The API never parses audio** — uploaded audio is decoded only inside sandboxed workers
  ([01 §10](../../specs/01-architecture.md)).
- LLM inputs containing user text are untrusted; the planner may only emit schema-validated ops
  ([06 §7](../../specs/06-ai-planner.md)).

**Status:** scaffold only. Filled by **WP-0.7**, together with `api-orchestrator` and the
`bragi_common` worker framework.
