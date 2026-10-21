/**
 * `POST /v1/plans/{planId}/execute` (06 §5, 05 §2).
 *
 * The plan is read from Postgres, re-checked, charged and enqueued: one interactive job per
 * generate step of every chosen variant. The contract D builds against: 400 for a missing context
 * asset or a tampered plan, 404 for an unknown plan or an asset the user does not own, 402 for the
 * allowance and 503 for the GPU budget.
 */
import type { EditPlan } from "@bragi/schemas";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { type AppContext, buildApp } from "../app.js";
import type { Session } from "../auth/session.js";
import { type Config, loadConfig } from "../config.js";
import { generationVariant, opsVariant, trackFx } from "../planner/__tests__/fixtures.js";

const HASH = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const PLAN_ID = "pln_01JAB5H7K8M9N0P1Q2R3S4T5V6";
const SESSION: Session = {
  user: { id: "usr_1", email: "owner@bragi.local", name: "Owner" },
  session: { id: "single-user", expiresAt: new Date("9999-12-31T00:00:00Z") },
};

/** The params of an inpaint as the planner returns them: `params.context` already filled. */
const INPAINT_PARAMS = {
  context: {
    bpm: 120,
    timeSignature: [4, 4],
    key: { tonic: "A", mode: "minor" },
    sectionKind: "verse",
    descriptors: ["synthwave"],
    seed: 1234,
  },
  gapBars: 1,
  overlapBars: 1,
  tier: "preview",
  n: 2,
  prompt: "a dusty drum fill",
};

/** A stored plan: one generative variant and one ops-only variant. */
function storedPlan(): EditPlan {
  return {
    planId: PLAN_ID,
    interpretation: "I'll fill the gap, or just warm the drums.",
    variants: [
      generationVariant("Fill", { params: INPAINT_PARAMS }),
      opsVariant("Warm", [trackFx("trk_drums")]),
    ],
    estimatedCredits: 4,
    estimatedSeconds: 30,
  };
}

/** A transition plan, for the two-sided context contract. */
function transitionPlan(): EditPlan {
  return {
    planId: PLAN_ID,
    interpretation: "I'll bridge the boundary.",
    variants: [
      generationVariant("Bridge", {
        capability: "generate.transition",
        params: {
          context: INPAINT_PARAMS.context,
          lengthBars: 2,
          tier: "preview",
          n: 1,
        },
        context: {
          before: { startTick: 0, endTick: 3840 },
          after: { startTick: 3840, endTick: 7680 },
          tracks: "all",
        },
        placement: {
          region: { startTick: 3840, endTick: 7680, tracks: "all" },
          mode: "replace",
          newTrack: { name: "Bridge", role: "other" },
        },
      }),
    ],
    estimatedCredits: 1,
    estimatedSeconds: 15,
  };
}

interface Query {
  readonly sql: string;
  readonly params?: readonly unknown[] | undefined;
}

class FakePool {
  readonly queries: Query[] = [];
  plan: unknown;
  creditsUsed = 0;
  gpuSeconds = 0;
  owned = true;

  async query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: unknown[]; rowCount: number }> {
    this.queries.push({ sql, params });
    if (sql.includes("FROM plans")) {
      return { rows: this.plan === undefined ? [] : [{ plan: this.plan }], rowCount: 1 };
    }
    if (sql.includes("SUM(credits)")) return { rows: [{ used: this.creditsUsed }], rowCount: 1 };
    if (sql.includes("SUM(gpu_seconds)")) {
      return { rows: [{ seconds: this.gpuSeconds }], rowCount: 1 };
    }
    if (sql.includes("FROM user_assets")) return { rows: [], rowCount: this.owned ? 1 : 0 };
    return { rows: [], rowCount: 1 };
  }

  /** The parameters of every statement whose SQL contains `fragment`. */
  paramsOf(fragment: string): (readonly unknown[] | undefined)[] {
    return this.queries
      .filter((query) => query.sql.includes(fragment))
      .map((query) => query.params);
  }
}

class FakeNats {
  readonly published: { subject: string; payload: unknown }[] = [];

  jetstream(): { publish: (subject: string, data: Uint8Array) => Promise<unknown> } {
    return {
      publish: async (subject, data) => {
        this.published.push({ subject, payload: JSON.parse(new TextDecoder().decode(data)) });
        return { seq: 1 };
      },
    };
  }
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function config(env: NodeJS.ProcessEnv = {}): Config {
  return loadConfig({ NODE_ENV: "test", BRAGI_AUTH_MODE: "single-user", ...env });
}

async function build(
  plan: unknown,
  env: NodeJS.ProcessEnv = {},
): Promise<{ app: FastifyInstance; pool: FakePool; nc: FakeNats }> {
  const pool = new FakePool();
  pool.plan = plan;
  const nc = new FakeNats();
  const ctx = {
    config: config(env),
    pool,
    nc,
    store: {},
    auth: {},
    sessions: { resolve: async () => SESSION },
  } as unknown as AppContext;
  const built = await buildApp(ctx);
  app = built.app;
  return { app: built.app, pool, nc };
}

function execute(body: Record<string, unknown>, planId = PLAN_ID) {
  return {
    method: "POST" as const,
    url: `/v1/plans/${planId}/execute`,
    payload: body,
  };
}

const CONTEXTS = { g1: { before: HASH, after: HASH_B } };

describe("POST /v1/plans/:planId/execute", () => {
  it("enqueues one interactive job per generate step of the default variants", async () => {
    const { app, pool, nc } = await build(storedPlan());
    const response = await app.inject(execute({ contexts: CONTEXTS }));

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      jobs: { variant: number; stepId: string; jobId: string; capability: string }[];
    }>();
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0]).toMatchObject({
      variant: 0,
      stepId: "g1",
      capability: "generate.inpaint",
      estimatedCredits: 4,
      status: "queued",
    });
    expect(body.jobs[0]?.jobId).toMatch(/^job_/);

    const jobs = pool.paramsOf("INSERT INTO jobs");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.[3]).toBe("generate.inpaint");
    expect(jobs[0]?.[4]).toBe("interactive");
    const params = JSON.parse(String(jobs[0]?.[6]));
    expect(params).toMatchObject({ planId: PLAN_ID, stepId: "g1", variant: 0, gapBars: 1 });
    expect(JSON.parse(String(jobs[0]?.[8]))).toEqual({ before: HASH, after: HASH_B });

    const ledger = pool.paramsOf("INSERT INTO usage_ledger");
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.[3]).toBe(4);
    expect(ledger[0]?.[4]).toBe("generate.inpaint");
    expect(ledger[0]?.[5]).toBe("preview");
    expect(nc.published).toHaveLength(1);
    expect(nc.published[0]?.subject).toBe("jobs.generate.inpaint.interactive");
  });

  it("returns no jobs when the chosen variant is ops-only", async () => {
    const { app, pool } = await build(storedPlan());
    const response = await app.inject(execute({ variants: [1], contexts: {} }));

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ jobs: [] });
    expect(pool.paramsOf("INSERT INTO jobs")).toHaveLength(0);
  });

  it("rejects an index the plan does not have", async () => {
    const { app, pool } = await build(storedPlan());
    const response = await app.inject(execute({ variants: [5], contexts: {} }));

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { message: string } }>().error.message).toContain("variant 5");
    expect(pool.paramsOf("INSERT INTO jobs")).toHaveLength(0);
  });

  it("answers 404 for an unknown or expired plan", async () => {
    const { app } = await build(undefined);
    const response = await app.inject(execute({ contexts: CONTEXTS }));

    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("NOT_FOUND");
  });

  it("requires both sides of a two-sided capability", async () => {
    const { app, pool } = await build(transitionPlan());
    const response = await app.inject(execute({ contexts: { g1: { before: HASH } } }));

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { message: string } }>().error.message).toContain(
      "contexts.g1 needs the rendered after audio",
    );
    expect(pool.paramsOf("INSERT INTO jobs")).toHaveLength(0);
  });

  it("rejects an asset key the capability does not take", async () => {
    const { app } = await build(storedPlan());
    const response = await app.inject(
      execute({ contexts: { g1: { ...CONTEXTS.g1, context: HASH } } }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { message: string } }>().error.message).toContain(
      "contexts.g1 has context",
    );
  });

  it("rejects a context hash that is not an asset address", async () => {
    const { app } = await build(storedPlan());
    const response = await app.inject(
      execute({ contexts: { g1: { before: HASH, after: "nope" } } }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { message: string } }>().error.message).toContain(
      "contexts.g1.after",
    );
  });

  it("refuses a context asset the user does not own", async () => {
    const { app, pool } = await build(storedPlan());
    pool.owned = false;
    const response = await app.inject(execute({ contexts: CONTEXTS }));

    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("NOT_FOUND");
    expect(pool.paramsOf("INSERT INTO jobs")).toHaveLength(0);
  });

  it("re-validates the stored plan instead of trusting it", async () => {
    const plan = storedPlan();
    const variant = plan.variants[0];
    if (variant === undefined) throw new Error("fixture has no variant");
    // Simulate a row written before a capability was retired or a bug that stored a bad step.
    variant.steps[0] = {
      kind: "generate",
      id: "g1",
      capability: "generate.stem",
      params: INPAINT_PARAMS,
      context: { tracks: "all" },
    };
    const { app, pool } = await build(plan);
    const response = await app.inject(execute({ contexts: CONTEXTS }));

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { message: string } }>().error.message).toContain(
      "not executable",
    );
    expect(pool.paramsOf("INSERT INTO jobs")).toHaveLength(0);
  });

  it("refuses a plan that does not fit the daily allowance with 402", async () => {
    const { app, pool } = await build(storedPlan(), { BRAGI_DAILY_CREDITS: "5" });
    pool.creditsUsed = 2;
    const response = await app.inject(execute({ contexts: CONTEXTS }));

    expect(response.statusCode).toBe(402);
    const body = response.json<{
      error: { code: string; details: { required: number; used: number; allowance: number } };
    }>();
    expect(body.error.code).toBe("INSUFFICIENT_CREDITS");
    expect(body.error.details).toEqual({ required: 4, used: 2, allowance: 5 });
    expect(pool.paramsOf("INSERT INTO jobs")).toHaveLength(0);
  });

  it("refuses a spent GPU budget with 503 before enqueueing anything", async () => {
    const { app, pool } = await build(storedPlan(), { BRAGI_GPU_SECONDS_PER_DAY: "10" });
    pool.gpuSeconds = 10;
    const response = await app.inject(execute({ contexts: CONTEXTS }));

    expect(response.statusCode).toBe(503);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("GENERATION_BUSY");
    expect(pool.paramsOf("INSERT INTO jobs")).toHaveLength(0);
  });

  it("validates the request body", async () => {
    const { app } = await build(storedPlan());
    const response = await app.inject(execute({ variants: "nope" }));

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("VALIDATION_FAILED");
  });

  it("requires a session", async () => {
    const pool = new FakePool();
    pool.plan = storedPlan();
    const ctx = {
      config: config(),
      pool,
      nc: new FakeNats(),
      store: {},
      auth: {},
      sessions: { resolve: async () => undefined },
    } as unknown as AppContext;
    const built = await buildApp(ctx);
    app = built.app;
    const response = await built.app.inject(execute({ contexts: CONTEXTS }));

    expect(response.statusCode).toBe(401);
  });
});
