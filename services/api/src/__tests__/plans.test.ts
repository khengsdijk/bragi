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

/** Records the insert the route makes so a proposed plan can be executed later. */
class FakePool {
  readonly queries: { sql: string; params?: readonly unknown[] | undefined }[] = [];

  async query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: unknown[]; rowCount: number }> {
    this.queries.push({ sql, params });
    return { rows: [], rowCount: 1 };
  }
}

/** A minimal app context: nothing under test touches NATS or S3. */
function context(pool: FakePool, planner?: AppContext["planner"]): AppContext {
  return {
    config: loadConfig({ NODE_ENV: "test" }),
    pool: pool as unknown as Pool,
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
    const { app } = await buildApp(context(new FakePool()));
    const response = await app.inject({
      method: "POST",
      url: "/v1/plans",
      payload: testRequest(),
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: "PLANNER_UNAVAILABLE" } });
    await app.close();
  });

  it("returns the EditPlan from an injected planner and stores it for execute", async () => {
    const plan = routePlan();
    const pool = new FakePool();
    const { app } = await buildApp(context(pool, { plan: async () => plan }));
    const response = await app.inject({
      method: "POST",
      url: "/v1/plans",
      payload: testRequest(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(plan);

    // 06 §5: the plan can be executed by id for 24 hours, so it is stored when it is returned.
    const insert = pool.queries.find((query) => query.sql.includes("INSERT INTO plans"));
    expect(insert?.params?.[0]).toBe(plan.planId);
    expect(insert?.params?.[1]).toBe("usr_1");
    expect(JSON.parse(String(insert?.params?.[2]))).toEqual(plan);
    expect(insert?.params?.[4]).toBeInstanceOf(Date);
    await app.close();
  });

  it("does not store an Explanation", async () => {
    const pool = new FakePool();
    const explanation = { text: "The intro is sparse.", highlights: [] };
    const { app } = await buildApp(context(pool, { plan: async () => explanation }));
    const response = await app.inject({
      method: "POST",
      url: "/v1/plans",
      payload: testRequest({ explain: true }),
    });
    expect(response.statusCode).toBe(200);
    expect(pool.queries.some((query) => query.sql.includes("INSERT INTO plans"))).toBe(false);
    await app.close();
  });

  it("validates the request body", async () => {
    const { app } = await buildApp(context(new FakePool(), { plan: async () => routePlan() }));
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
    const ctx = context(new FakePool(), { plan: async () => routePlan() });
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
