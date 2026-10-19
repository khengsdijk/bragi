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
  // Presigned upload/download URLs point at object storage (05 §2): allow its origin in connect-src.
  // The dev default is the compose MinIO (`S3_PUBLIC_ENDPOINT`); a deployment sets the variable.
  const blobOrigins = (
    process.env.BRAGI_BLOB_ORIGINS ??
    (command === "serve" ? "http://127.0.0.1:9000,http://localhost:9000" : "")
  )
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin !== "");
  const headers = securityHeaders(command === "serve" ? "development" : "production", blobOrigins);
  // The API (05 §2, §3) is proxied rather than called cross-origin: the page
  // stays same-origin, so the Better Auth session cookie is an ordinary
  // same-site cookie and `Origin` matches the API's trusted origins. `ws: true`
  // covers `/v1/ws` (05 §3). Finding 9.
  const proxy = {
    "/v1": { target: "http://127.0.0.1:8080", ws: true },
  } as const;
  return {
    // Pinned to IPv4 so the end-to-end run polls the address the server really
    // bound to; `localhost` can resolve to ::1 only.
    server: { headers, host: "127.0.0.1", port: 5173, strictPort: true, proxy },
    preview: { headers, host: "127.0.0.1", port: 5174, strictPort: true, proxy },
    // `@bragi/model-wasm` also locates its `.wasm` relative to its own `import.meta.url`.
    optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm", "@bragi/model-wasm"] },
    // The engine worklet (`?worker&url`) is an ES module bundle with the wasm glue inlined.
    worker: { format: "es" as const },
    build: {
      target: "es2022",
      sourcemap: true,
      // The Tauri build reads this directory (tauri.conf.json `frontendDist`).
      outDir: "dist",
      emptyOutDir: true,
    },
  };
});
