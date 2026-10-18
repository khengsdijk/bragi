import { defineConfig } from "vitest/config";

/**
 * The acceptance integration test (WP-0.7). It is deliberately *not* matched by
 * the package's default `vitest run`, because it needs the docker compose stack:
 *
 *   docker compose -f infra/docker-compose.yml up -d --wait        # shared infra
 *   docker compose -f infra/docker-compose.yml up -d --build api worker jaeger
 *   pnpm test:integration
 */
export default defineConfig({
  test: {
    include: ["test/integration/**/*.integration.ts"],
    // The stack build can be slow the first time; hooks wait for it.
    hookTimeout: 600_000,
    testTimeout: 120_000,
    fileParallelism: false,
  },
});
