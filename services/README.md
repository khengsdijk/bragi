# services/

The cloud side.

| Directory | What it is | Filled by |
|---|---|---|
| [`api/`](api) | Fastify API: auth, projects, sync, assets, jobs, search, planner module, WebSocket gateway | WP-0.7 |
| [`workers/`](workers) | Python uv workspace: analysis, embedding and generation workers | WP-0.7 onwards |

Specs: [05-backend-and-jobs.md](../specs/05-backend-and-jobs.md),
[04-analysis-pipeline.md](../specs/04-analysis-pipeline.md),
[09-generation.md](../specs/09-generation.md).
