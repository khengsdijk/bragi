# infra/

Local infrastructure and (from Phase 3) deployment.

| Path | What it is |
|---|---|
| [`docker-compose.yml`](docker-compose.yml) | Postgres 17 + pgvector, MinIO, NATS JetStream, Mailpit |
| [`postgres/init/`](postgres/init) | SQL run once on first database start |
| [`deploy/`](deploy) | IaC for staging and production — added in Phase 3+ |

## Usage

```bash
pnpm infra:up      # start everything and wait for healthy
pnpm infra:logs    # follow logs
pnpm infra:down    # stop and delete the volumes
```

Ports, credentials and defaults live in [`.env.example`](.env.example). The local credentials are
deliberately weak development values; real secrets never enter this repository
([13 §1](../specs/13-agent-guide.md)).
