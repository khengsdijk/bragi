import { defineConfig } from "vite";

/**
 * Builds the in-page driver the Tauri selftest evaluates
 * (`apps/desktop/scripts/selftest.mjs`):
 *
 *     vite build --config e2e/selftest.vite.config.ts
 *
 * One self-contained IIFE — no dynamic imports, because the webview gets the
 * script as a single string — exposed as `BragiSelftest`, whose `main(phase)`
 * runs one half of the shared scenario.
 *
 * This bundle is a test artefact: it is built into `e2e/dist/`, is never
 * referenced by `index.html`, and therefore never ships in the app bundle.
 */
export default defineConfig({
  build: {
    target: "es2022",
    outDir: "e2e/dist",
    emptyOutDir: true,
    // Readable in a failure report; the webview does not care about the size.
    minify: false,
    sourcemap: false,
    lib: {
      entry: "e2e/selftest-entry.ts",
      name: "BragiSelftest",
      formats: ["iife"],
      fileName: () => "selftest.js",
    },
  },
});
