# @bragi/api-client

The typed client for [`services/api`](../../services/api), **generated** from the OpenAPI 3.1
document that Fastify produces from its route schemas ([01 §7](../../specs/01-architecture.md)).

Server state is consumed through TanStack Query, and live updates arrive over a single `realtime`
WebSocket client that updates Query caches and the Song Store
([13 §3](../../specs/13-agent-guide.md)) — not through ad-hoc `fetch` calls in features.

**Status:** scaffold only. Generated code arrives with **WP-0.7**, when the API has routes to
describe.
