import { defineConfig } from "@playwright/test";

/**
 * Web end-to-end runs (13 §6: Playwright against Chromium, Firefox and
 * Playwright WebKit).
 *
 * Every browser runs the one shared scenario twice: against the **dev server**
 * (`vite dev`, headers from `src/headers.ts`) and against **`vite preview` of the
 * production build** (`vite build` + `vite preview`), because the two are served
 * by different code paths — a header set that only holds in dev would still ship
 * a broken app.
 *
 * macOS WebKit is the engine Safari uses, but it is *Playwright WebKit*, not
 * Safari: see the platform table in docs/wp/0.5.md.
 */
const DEV_PORT = 5173;
const PREVIEW_PORT = 5174;
const dev = `http://127.0.0.1:${DEV_PORT}`;
const preview = `http://127.0.0.1:${PREVIEW_PORT}`;

export default defineConfig({
  testDir: "e2e",
  testMatch: /platform\.spec\.ts$/,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    // The suite builds its own contexts (see e2e/platform.spec.ts), so the
    // runner's trace/video options would not apply; it reports through the
    // driver's transcript instead.
    trace: "off",
    testIdAttribute: "data-testid",
  },
  webServer: [
    {
      command: `vite --port ${DEV_PORT} --strictPort`,
      url: dev,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: "pipe",
    },
    {
      // The preview server must serve a production build: that is what a CDN
      // would serve, and what the desktop app embeds.
      command: `vite build && vite preview --port ${PREVIEW_PORT} --strictPort`,
      url: preview,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      stdout: "pipe",
    },
  ],
  projects: [
    // `devices[…]` presets are not used: the suite builds its own contexts
    // (e2e/platform.spec.ts), so only the origin differs per project.
    { name: "chromium-dev", use: { baseURL: dev } },
    { name: "chromium-preview", use: { baseURL: preview } },
    { name: "firefox-dev", use: { baseURL: dev } },
    { name: "firefox-preview", use: { baseURL: preview } },
    { name: "webkit-dev", use: { baseURL: dev } },
    { name: "webkit-preview", use: { baseURL: preview } },
  ],
});
