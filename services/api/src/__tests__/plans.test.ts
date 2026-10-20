import type { NatsConnection } from "nats";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AppContext, buildApp } from "../app.js";
import type { AuthInstance } from "../auth/auth.js";
import { loadConfig } from "../config.js";
import { routePlan, testRequest } from "../planner/__tests__/fixtures.js";
import { PLANS_BODY_LIMIT } from "../routes/plans.js";
import type { ObjectStore } from "../s3/client.js";

const SESSION = {
  user: { id: "usr_1", email: "owner@bragi.local", name: "Owner" },
  session: { id: "single-user", expiresAt: new Date("9999-12-31T00:00:00Z") },
};

/** A minimal app context: no route under test touches Postgres, NATS or S3. */
function context(planner?: AppContext["planner"]): AppContext {
  return {
    config: loadConfig({ NODE_ENV: "test" }),
    pool: {} as Pool,
    nc: {} as NatsConnection,
    store: {} as ObjectStore,
    auth: { api: {}, handler: async () => new Response(null) } as unknown as AuthInstance,
    sessions: { resolve: async () => SESSION },
    ...(planner === undefined ? {} : { planner }),
  };
}

const originalKey = process.env.OPENROUTER_API_KEY;

beforeEach(() => {
  delete process.env.OPENROUTER_API_KEY;
});

afterEach(() => {
  if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalKey;
});

describe("POST /v1/plans", () => {
  it("allows an 8 MB body for the song document", () => {
    expect(PLANS_BODY_LIMIT).toBe(8 * 1024 * 1024);
  });

  it("returns PLANNER_UNAVAILABLE without a key and without an injected planner", async () => {
    const { app } = await buildApp(context());
    const response = await app.inject({
      method: "POST",
      url: "/v1/plans",
      payload: testRequest(),
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: "PLANNER_UNAVAILABLE" } });
    await app.close();
  });

  it("returns the EditPlan from an injected planner", async () => {
    const plan = routePlan();
    const { app } = await buildApp(context({ plan: async () => plan }));
    const response = await app.inject({
      method: "POST",
      url: "/v1/plans",
      payload: testRequest(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(plan);
    await app.close();
  });

  it("validates the request body", async () => {
    const { app } = await buildApp(context({ plan: async () => routePlan() }));
    const response = await app.inject({
      method: "POST",
      url: "/v1/plans",
      payload: { prompt: "" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "VALIDATION_FAILED" } });
    await app.close();
  });

  it("requires a session", async () => {
    const ctx = context({ plan: async () => routePlan() });
    ctx.sessions = { resolve: async () => undefined };
    const { app } = await buildApp(ctx);
    const response = await app.inject({
      method: "POST",
      url: "/v1/plans",
      payload: testRequest(),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "AUTH_REQUIRED" } });
    await app.close();
  });
});
