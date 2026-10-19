import { describe, expect, it } from "vitest";

import { contentSecurityPolicy, securityHeaders } from "../headers.js";

describe("securityHeaders", () => {
  it.each(["development", "production"] as const)(
    "makes the page cross-origin isolated in %s",
    (mode) => {
      const headers = securityHeaders(mode);
      // Without both of these, `crossOriginIsolated` is false and sqlite-wasm
      // and SharedArrayBuffer are unavailable (01 §3).
      expect(headers["Cross-Origin-Opener-Policy"]).toBe("same-origin");
      expect(headers["Cross-Origin-Embedder-Policy"]).toBe("require-corp");
    },
  );

  it.each(["development", "production"] as const)(
    "allows wasm and nothing remote in %s",
    (mode) => {
      const csp = contentSecurityPolicy(mode);
      expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
      // `'wasm-unsafe-eval'` is not `'unsafe-eval'`: the latter would also allow
      // eval of arbitrary strings.
      expect(csp).not.toContain("'unsafe-eval'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("base-uri 'none'");
      expect(csp).not.toMatch(/https?:\/\//);
    },
  );

  it("only relaxes the policy in development, and only for Vite", () => {
    const dev = contentSecurityPolicy("development");
    const prod = contentSecurityPolicy("production");
    // Vite injects CSS as <style> in dev and talks to its HMR websocket.
    expect(dev).toContain("style-src 'self' 'unsafe-inline'");
    expect(dev).toContain("connect-src 'self' ws: wss:");
    // The production build links a stylesheet and needs no websocket.
    expect(prod).toContain("style-src 'self';");
    expect(prod).toContain("connect-src 'self';");
    expect(prod).not.toContain("ws:");
    expect(prod).not.toContain("'unsafe-inline'");
  });

  it("keeps every directive in the production policy strict", () => {
    const directives = contentSecurityPolicy("production").split("; ");
    const wildcard = directives.filter((directive) => directive.endsWith(" *"));
    expect(wildcard).toEqual([]);
    expect(directives).toContain("frame-ancestors 'none'");
    expect(directives).toContain("form-action 'none'");
  });

  it("adds the object-store origin to connect-src only when given one", () => {
    expect(contentSecurityPolicy("production", ["https://blobs.example"])).toContain(
      "connect-src 'self' https://blobs.example;",
    );
    expect(contentSecurityPolicy("development", ["http://127.0.0.1:9000"])).toContain(
      "connect-src 'self' ws: wss: http://127.0.0.1:9000;",
    );
  });
});
