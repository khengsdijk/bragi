# infra/

Local infrastructure and (from Phase 3) deployment.

| Path | What it is |
|---|---|
| [`docker-compose.yml`](docker-compose.yml) | Postgres 17 + pgvector, MinIO, NATS JetStream, Mailpit, the `api` and `worker` services and a dev-only `jaeger` (WP-0.7) |
| [`postgres/init/`](postgres/init) | SQL run once on first database start |
| [`deploy/`](deploy) | IaC for staging and production — added in Phase 3+ |

## Usage

```bash
pnpm infra:up      # start the infrastructure and wait for healthy
pnpm infra:logs    # follow logs
pnpm infra:down    # stop and delete the volumes

# the application services this work package adds:
docker compose -f docker-compose.yml up -d --build api worker jaeger
```

**Never run `infra:down` while other worktrees share this project**, and bring up only the
services you added: the infrastructure containers are shared. `api` runs `api-http` and
`api-orchestrator` (migrations first); `worker` runs the Python worker (today the `echo`
capability). `jaeger` stores traces locally at http://127.0.0.1:16686 so the API → NATS → worker
trace is visible (05 §11).

`postgres/init/*.sql` runs **only on an empty data volume**. After adding or changing a file there,
run `pnpm infra:down` (which deletes the volumes) before `pnpm infra:up`, or the new SQL will never
execute.

Ports, credentials and defaults live in [`.env.example`](.env.example). The local credentials are
deliberately weak development values; real secrets never enter this repository
([13 §1](../specs/13-agent-guide.md)).
