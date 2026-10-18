import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Component tests need a DOM; the token tests do not care but run in the same environment.
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    globals: false,
    setupFiles: ["src/__tests__/setup.ts"],
  },
});
