import { defineConfig } from "vite";

import { securityHeaders } from "./src/headers.js";

/**
 * One Vite entry for both hosts (01 §3): this build output is what the browser
 * loads *and* what `apps/desktop` embeds (`frontendDist: ../../web/dist`).
 *
 * Three things here are load-bearing:
 *
 * 1. **COOP/COEP on `server` and `preview`** — the page must be cross-origin
 *    isolated, and the preview server must send exactly what a CDN will
 *    (01 §9). The policy lives in `src/headers.ts` and is unit-tested there.
 * 2. **`optimizeDeps.exclude` for `@sqlite.org/sqlite-wasm`** — the package
 *    locates `sqlite3.wasm` relative to its own `import.meta.url`, which only
 *    survives if Vite transforms it instead of esbuild pre-bundling it. The
 *    package's own README asks for exactly this.
 * 3. **No React plugin.** Vite 8 transforms `.tsx` with oxc, which already uses
 *    the automatic React runtime (no `React` import needed). `packages/app`
 *    therefore builds with `jsx: react-jsx` and Vite consumes its output as
 *    plain ESM; Fast Refresh is the only thing given up, and the app has no
 *    component state to preserve yet.
 */
export default defineConfig(({ command }) => {
  const headers = securityHeaders(command === "serve" ? "development" : "production");
  return {
    // Pinned to IPv4 so the end-to-end run polls the address the server really
    // bound to; `localhost` can resolve to ::1 only.
    server: { headers, host: "127.0.0.1", port: 5173, strictPort: true },
    preview: { headers, host: "127.0.0.1", port: 5174, strictPort: true },
    optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
    build: {
      target: "es2022",
      sourcemap: true,
      // The Tauri build reads this directory (tauri.conf.json `frontendDist`).
      outDir: "dist",
      emptyOutDir: true,
    },
  };
});
