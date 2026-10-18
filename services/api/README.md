# @bragi/api

The Fastify API ([05-backend-and-jobs.md](../../specs/05-backend-and-jobs.md)): auth, projects,
sync (commits), assets (presigned S3 URLs), jobs, search, the AI planner module and the WebSocket
gateway.

Notes:

- Configuration comes from environment variables and is validated at boot with zod. No secrets in
  the repo ([01 §8](../../specs/01-architecture.md)).
- Route schemas are the source of the OpenAPI 3.1 document that generates
  [`@bragi/api-client`](../../packages/api-client). **Not yet:** WP-0.7 validates each route's input
  directly; the OpenAPI generation lands with `packages/api-client` in WP-1.10.
- **The API never parses audio** — uploaded audio is decoded only inside sandboxed workers
  ([01 §10](../../specs/01-architecture.md)).
- LLM inputs containing user text are untrusted; the planner may only emit schema-validated ops
  ([06 §7](../../specs/06-ai-planner.md)).

## Running it

```bash
pnpm infra:up                     # postgres, minio, nats, mailpit (shared, never torn down by tests)
pnpm build                        # builds @bragi/schemas then @bragi/api into dist/
node services/api/dist/db/migrate-cli.js
node services/api/dist/server.js          # api-http
node services/api/dist/orchestrator.js    # api-orchestrator
```

Or through compose: `docker compose -f infra/docker-compose.yml up -d --build api` (the container
runs migrations, then both entrypoints). `pnpm test:integration` exercises the whole path; see
[`docs/wp/0.7.md`](../../docs/wp/0.7.md).

**Status:** built by **WP-0.7**. The projects/sync, planner, search and usage endpoints of
[05 §2](../../specs/05-backend-and-jobs.md) land in WP-1.10/WP-2.x, on the same app.
