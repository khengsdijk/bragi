import { defineConfig } from "vitest/config";

/**
 * Unit tests only (`src/**`). The Playwright suite in `e2e/` has its own runner
 * and must not be collected by Vitest — it imports `@playwright/test`, which
 * refuses to run outside `playwright test`.
 */
export default defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    environment: "node",
  },
});
