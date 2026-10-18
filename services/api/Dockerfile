# The API image: `api-http` and `api-orchestrator`, one codebase (specs/05 §1).
#
# The context is the repository root (the pnpm workspace is needed to build
# `@bragi/api`), so build with:
#   docker compose -f infra/docker-compose.yml up -d --build api
FROM node:24-alpine
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @bragi/schemas build \
 && pnpm --filter @bragi/api build
COPY services/api/docker-entrypoint.sh /usr/local/bin/bragi-api-entrypoint
RUN chmod +x /usr/local/bin/bragi-api-entrypoint
ENV NODE_ENV=production
WORKDIR /app/services/api
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/bragi-api-entrypoint"]
