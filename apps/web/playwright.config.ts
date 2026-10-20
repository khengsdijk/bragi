import { defineConfig } from "@playwright/test";

/**
 * Web end-to-end runs (13 §6: Playwright against Chromium, Firefox and
 * Playwright WebKit).
 *
 * Every browser runs the shared specs twice: against the **dev server**
 * (`vite dev`, headers from `src/headers.ts`) and against **`vite preview` of the
 * production build** (`vite build` + `vite preview`), because the two are served
 * by different code paths — a header set that only holds in dev would still ship
 * a broken app.
 *
 * `browserName` is set explicitly on every project. WP-0.5 left it out, which made
 * the "firefox" projects run Chromium (Playwright's default); WP-1.9 found that and
 * fixed it (see docs/wp/1.9.md).
 *
 * `chromium-webgl` and `chromium-webgpu` are the "WebGPU off" and "WebGPU on" halves of the visual-regression pair (13 §6):
 * headless Chromium has no WebGPU adapter by default, so Pixi falls back to WebGL2
 * in the other projects, and `chromium-webgpu` opts into a real adapter. The flags differ
 * per OS; only the macOS (Metal) set has been exercised.
 *
 * macOS WebKit is the engine Safari uses, but it is *Playwright WebKit*, not
 * Safari: see the platform table in docs/wp/0.5.md.
 */
const DEV_PORT = 5173;
const PREVIEW_PORT = 5174;
const dev = `http://127.0.0.1:${DEV_PORT}`;
const preview = `http://127.0.0.1:${PREVIEW_PORT}`;

// Headless Chromium rasterises WebGL in software unless it is pointed at the GPU, which makes any
// timing meaningless; `chromium-webgl` and `chromium-webgpu` do that. Only the macOS (Metal) flags have
// been exercised.
const GPU_ARGS =
  process.platform === "darwin"
    ? ["--use-angle=metal", "--ignore-gpu-blocklist"]
    : ["--enable-features=Vulkan", "--ignore-gpu-blocklist"];
const WEBGPU_ARGS = ["--enable-unsafe-webgpu", ...GPU_ARGS];

export default defineConfig({
  testDir: "e2e",
  testMatch:
    /(platform|song-canvas|song-audio|brush-paint|canvas-visual|canvas-perf|upload-flow|history-flow|inspector-flow|section-flow|audition-flow|brush-flow|reopen-play|planner-flow|planner-prompt)\.spec\.ts$/,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  timeout: 90_000,
  expect: {
    timeout: 15_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: "disabled" },
  },
  // One golden per image, shared by the WebGL2 and WebGPU runs: that is the comparison.
  snapshotPathTemplate: "{testDir}/__screenshots__/{platform}/{arg}{ext}",
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    // The platform suite builds its own contexts (see e2e/platform.spec.ts), so
    // the runner's trace/video options would not apply; it reports through the
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
    // `devices[…]` presets are not used: the suites build their own contexts,
    // so only the browser and the origin differ per project.
    { name: "chromium-dev", use: { browserName: "chromium", baseURL: dev } },
    { name: "chromium-preview", use: { browserName: "chromium", baseURL: preview } },
    { name: "firefox-dev", use: { browserName: "firefox", baseURL: dev } },
    { name: "firefox-preview", use: { browserName: "firefox", baseURL: preview } },
    { name: "webkit-dev", use: { browserName: "webkit", baseURL: dev } },
    { name: "webkit-preview", use: { browserName: "webkit", baseURL: preview } },
    {
      // WebGL2 on the real GPU: the "WebGPU off" half of the visual pair and the WebGL timings.
      name: "chromium-webgl",
      use: { browserName: "chromium", baseURL: preview, launchOptions: { args: GPU_ARGS } },
    },
    {
      name: "chromium-webgpu",
      use: {
        browserName: "chromium",
        baseURL: preview,
        launchOptions: { args: WEBGPU_ARGS },
      },
    },
  ],
});
