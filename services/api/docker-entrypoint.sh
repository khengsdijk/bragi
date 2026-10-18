#!/bin/sh
# The `api` service runs both of the spec's processes (05 §1): `api-http` as
# PID 1 (so it receives the container's SIGTERM) and `api-orchestrator` beside
# it. Migrations run first and are idempotent, so a restart is safe.
set -eu

echo "api: applying database migrations"
node dist/db/migrate-cli.js

echo "api: starting api-orchestrator"
node dist/orchestrator.js &

echo "api: starting api-http"
exec node dist/server.js
