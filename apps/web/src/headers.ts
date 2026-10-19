/**
 * The response headers every Bragi web deployment must send (01 §3, §9).
 *
 * `Cross-Origin-Opener-Policy` + `Cross-Origin-Embedder-Policy` are what make
 * the page **cross-origin isolated**, which is what `SharedArrayBuffer` — and
 * therefore the audio engine's ring buffers (WP-1.1) — and sqlite-wasm's
 * threaded build need. Without them `crossOriginIsolated` is `false` and the
 * storage worker cannot start.
 *
 * The CSP is deliberately sent as a header rather than a `<meta>` tag: a meta
 * CSP would also apply inside the Tauri webview and block its IPC, so the
 * desktop gets its own policy from `tauri.conf.json`. This module is the single
 * definition for `vite dev` and `vite preview`; the future deploy work package
 * (01 §9) must send the same set from the CDN.
 */

/** Which server is asking: the dev server or a build of the app. */
export type HeaderMode = "development" | "production";

/** 01 §9: static assets are served with long-lived immutable hashes. */
const SCRIPT_SOURCES = "'self' 'wasm-unsafe-eval'";
const STYLE_SOURCES = "'self'";
const CONNECT_SOURCES = "'self'";

/**
 * The Content-Security-Policy for a web build.
 *
 * `'wasm-unsafe-eval'` is what lets the browser compile sqlite-wasm's module and
 * is narrower than `'unsafe-eval'`. Nothing remote is allowed: no CDN, no
 * analytics, no fonts.
 *
 * `blobOrigins` are the object-store origins presigned URLs point at (`S3_PUBLIC_ENDPOINT`); the
 * deploy sets them, `vite.config.ts` reads `BRAGI_BLOB_ORIGINS` (dev default: the compose MinIO).
 *
 * Dev adds what Vite needs, and only dev: `'unsafe-inline'` for the `<style>`
 * elements Vite injects for CSS in dev (the production build links a CSS file)
 * and `ws:`/`wss:` for its HMR websocket.
 */
export function contentSecurityPolicy(
  mode: HeaderMode,
  blobOrigins: readonly string[] = [],
): string {
  const dev = mode === "development";
  // Uploads and downloads go straight to object storage through presigned URLs (05 §2), a
  // different origin from the page: it is the one remote origin the app may talk to.
  const connect = [CONNECT_SOURCES, ...(dev ? ["ws:", "wss:"] : []), ...blobOrigins].join(" ");
  return [
    "default-src 'self'",
    `script-src ${SCRIPT_SOURCES}`,
    `style-src ${dev ? `${STYLE_SOURCES} 'unsafe-inline'` : STYLE_SOURCES}`,
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self'",
    `connect-src ${connect}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** The headers a web build must be served with. */
export function securityHeaders(
  mode: HeaderMode,
  blobOrigins: readonly string[] = [],
): Record<string, string> {
  return {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Content-Security-Policy": contentSecurityPolicy(mode, blobOrigins),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
}
