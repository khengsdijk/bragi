import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../app.js";
import { createSessionResolver, type SessionResolverOptions } from "../auth/session.js";
import { loadConfig } from "../config.js";

type AuthApi = SessionResolverOptions["authApi"];

const OWNER = { id: "usr_1", email: "owner@bragi.local", name: "Owner" };

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** Builds the app with fakes and the session resolver for `mode` (ADR-0014). */
async function build(mode: "single-user" | "multi-user", getSession: AuthApi["getSession"]) {
  const config = loadConfig({ NODE_ENV: "test", BRAGI_AUTH_MODE: mode });
  const sessions = createSessionResolver({
    mode,
    authApi: { getSession } as unknown as AuthApi,
    ...(mode === "single-user" ? { owner: OWNER } : {}),
  });
  const built = await buildApp({
    config,
    pool: {
      query: async () => ({ rows: [], rowCount: 0 }),
    },
    nc: {},
    store: {},
    auth: { api: { getSession }, handler: async () => new Response() },
    sessions,
    ...(mode === "single-user" ? { owner: OWNER } : {}),
  } as unknown as Parameters<typeof buildApp>[0]);
  app = built.app;
  return built.app;
}

const signedOut: AuthApi["getSession"] = (async () => null) as AuthApi["getSession"];

describe("GET /v1/auth/mode", () => {
  it("returns the owner in single-user mode without a cookie", async () => {
    const instance = await build("single-user", signedOut);
    const response = await instance.inject({ method: "GET", url: "/v1/auth/mode" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ mode: "single-user", user: OWNER });
  });

  it("returns null for a signed-out request in multi-user mode", async () => {
    const instance = await build("multi-user", signedOut);
    const response = await instance.inject({ method: "GET", url: "/v1/auth/mode" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ mode: "multi-user", user: null });
  });

  it("resolves the signed-in user from the cookie in multi-user mode", async () => {
    const getSession = (async () => ({
      user: OWNER,
      session: { id: "s1", expiresAt: new Date() },
    })) as unknown as AuthApi["getSession"];
    const instance = await build("multi-user", getSession);
    const response = await instance.inject({
      method: "GET",
      url: "/v1/auth/mode",
      headers: { cookie: "better-auth.session_token=x" },
    });
    expect(response.json()).toEqual({ mode: "multi-user", user: OWNER });
  });
});

describe("requireSession with the resolver (ADR-0014)", () => {
  it("serves a guarded route with no cookie in single-user mode", async () => {
    const instance = await build("single-user", signedOut);
    const response = await instance.inject({ method: "GET", url: "/v1/library" });
    expect(response.statusCode).toBe(200);
  });

  it("returns 401 AUTH_REQUIRED with no cookie in multi-user mode", async () => {
    const instance = await build("multi-user", signedOut);
    const response = await instance.inject({ method: "GET", url: "/v1/library" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "AUTH_REQUIRED" } });
  });
});
