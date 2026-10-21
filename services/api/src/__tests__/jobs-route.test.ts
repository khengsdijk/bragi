/**
 * `POST /v1/jobs` and `POST /v1/generations/warmup` against the real Fastify app
 * with a canned database and bus (05 §2, §9; 09 §5). The contract E2 builds
 * against: 400 names the field, 402 says how many credits are missing, 503
 * `GENERATION_BUSY` when the GPU budget is spent, and 202 carries
 * `estimatedCredits`.
 */
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { type AppContext, buildApp } from "../app.js";
import type { Session } from "../auth/session.js";
import { type Config, loadConfig } from "../config.js";
import { WarmupService } from "../jobs/warmup.js";

const HASH = `sha256:${"a".repeat(64)}`;
const SESSION: Session = {
  user: { id: "usr_1", email: "owner@bragi.local", name: "Owner" },
  session: { id: "single-user", expiresAt: new Date("9999-12-31T00:00:00Z") },
};

const EXTEND = {
  context: {
    bpm: 120,
    timeSignature: [4, 4],
    key: { tonic: "A", mode: "minor" },
    descriptors: ["warm analog synths"],
    seed: 1234,
  },
  bars: 15,
  overlapBars: 2,
  direction: "forward",
  tier: "preview",
  n: 3,
};

interface Query {
  readonly sql: string;
  readonly params?: readonly unknown[] | undefined;
}

class FakePool {
  readonly queries: Query[] = [];
  creditsUsed = 0;
  gpuSeconds = 0;
  owned = true;
  warmup: { status: string; created_at: Date; finished_at: Date | null }[] = [];

  async query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: unknown[]; rowCount: number }> {
    this.queries.push({ sql, params });
    if (sql.includes("SUM(credits)")) return { rows: [{ used: this.creditsUsed }], rowCount: 1 };
    if (sql.includes("SUM(gpu_seconds)"))
      return { rows: [{ seconds: this.gpuSeconds }], rowCount: 1 };
    if (sql.includes("FROM user_assets")) return { rows: [], rowCount: this.owned ? 1 : 0 };
    if (sql.includes("FROM jobs") && sql.includes("ORDER BY created_at DESC")) {
      return { rows: this.warmup, rowCount: this.warmup.length };
    }
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
  env: NodeJS.ProcessEnv = {},
): Promise<{ app: FastifyInstance; pool: FakePool; nc: FakeNats; config: Config }> {
  const pool = new FakePool();
  const nc = new FakeNats();
  const cfg = config(env);
  const ctx = {
    config: cfg,
    pool,
    nc,
    store: {},
    auth: {},
    sessions: { resolve: async () => SESSION },
  } as unknown as AppContext;
  const built = await buildApp(ctx);
  app = built.app;
  return { app: built.app, pool, nc, config: cfg };
}

function submit(body: Record<string, unknown>) {
  return { method: "POST" as const, url: "/v1/jobs", payload: body };
}

describe("POST /v1/jobs — params validation", () => {
  it("accepts a valid generate.extend and returns estimatedCredits", async () => {
    const { app, pool } = await build();
    const response = await app.inject(
      submit({ capability: "generate.extend", assets: { context: HASH }, params: EXTEND }),
    );

    expect(response.statusCode).toBe(202);
    const body = response.json<{ jobId: string; status: string; estimatedCredits: number }>();
    expect(body.jobId).toMatch(/^job_/);
    expect(body.status).toBe("queued");
    expect(body.estimatedCredits).toBe(6);

    const ledger = pool.paramsOf("INSERT INTO usage_ledger");
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toEqual([
      expect.stringMatching(/^led_/),
      "usr_1",
      body.jobId,
      6,
      "generate.extend",
      "preview",
      "generate.extend interactive",
    ]);
  });

  it("names the offending field in a 400", async () => {
    const { app } = await build();
    const response = await app.inject(
      submit({
        capability: "generate.extend",
        assets: { context: HASH },
        params: { ...EXTEND, bars: 0 },
      }),
    );

    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(body.error.message).toContain("params.bars");
    expect(body.error.message).toContain(">= 1");
  });

  it("names a missing required field", async () => {
    const { app } = await build();
    const withoutCandidates: Record<string, unknown> = { ...EXTEND };
    delete withoutCandidates.n;
    const response = await app.inject(
      submit({
        capability: "generate.extend",
        assets: { context: HASH },
        params: withoutCandidates,
      }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { message: string } }>().error.message).toContain(
      "params.n is required",
    );
  });

  it("requires the rendered context asset", async () => {
    const { app } = await build();
    const response = await app.inject(
      submit({ capability: "generate.extend", assets: {}, params: EXTEND }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { message: string } }>().error.message).toContain(
      "assets.context",
    );
  });

  it("keeps the pre-2.7 behaviour for capabilities without a schema", async () => {
    const { app } = await build();
    const response = await app.inject(
      submit({ capability: "analysis.separation", params: { anything: true } }),
    );
    expect(response.statusCode).toBe(202);
    expect(response.json<{ estimatedCredits: number }>().estimatedCredits).toBe(0);
  });

  it("refuses to generate from an asset the user does not own", async () => {
    const { app, pool } = await build();
    pool.owned = false;
    const response = await app.inject(
      submit({ capability: "generate.extend", assets: { context: HASH }, params: EXTEND }),
    );

    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("NOT_FOUND");
    expect(pool.paramsOf("INSERT INTO jobs")).toHaveLength(0);
  });
});

describe("POST /v1/jobs — credits", () => {
  it("refuses a job that does not fit the daily allowance with 402", async () => {
    const { app, pool } = await build({ BRAGI_DAILY_CREDITS: "8" });
    pool.creditsUsed = 3;
    const response = await app.inject(
      submit({ capability: "generate.extend", assets: { context: HASH }, params: EXTEND }),
    );

    expect(response.statusCode).toBe(402);
    const body = response.json<{
      error: { code: string; details: { required: number; used: number; allowance: number } };
    }>();
    expect(body.error.code).toBe("INSUFFICIENT_CREDITS");
    expect(body.error.details).toEqual({ required: 6, used: 3, allowance: 8 });
    expect(pool.paramsOf("INSERT INTO jobs")).toHaveLength(0);
  });

  it("records every charged job, even with an unlimited single-user allowance", async () => {
    const { app, pool } = await build();
    const response = await app.inject(
      submit({ capability: "generate.extend", assets: { context: HASH }, params: EXTEND }),
    );
    expect(response.statusCode).toBe(202);
    expect(pool.paramsOf("INSERT INTO usage_ledger")).toHaveLength(1);
  });
});

describe("POST /v1/jobs — the GPU budget guard", () => {
  it("refuses interactive generation with 503 GENERATION_BUSY", async () => {
    const { app, pool } = await build({ BRAGI_GPU_SECONDS_PER_DAY: "100" });
    pool.gpuSeconds = 100;
    const response = await app.inject(
      submit({ capability: "generate.extend", assets: { context: HASH }, params: EXTEND }),
    );

    expect(response.statusCode).toBe(503);
    expect(response.json<{ error: { code: string } }>().error.code).toBe("GENERATION_BUSY");
    expect(pool.paramsOf("INSERT INTO jobs")).toHaveLength(0);
  });

  it("records a background job as paused instead of enqueueing it", async () => {
    const { app, pool, nc } = await build({ BRAGI_GPU_SECONDS_PER_DAY: "100" });
    pool.gpuSeconds = 120;
    const response = await app.inject(
      submit({
        capability: "generate.extend",
        priority: "background",
        assets: { context: HASH },
        params: { ...EXTEND, n: 1, tier: "hq" },
      }),
    );

    expect(response.statusCode).toBe(202);
    expect(response.json<{ status: string; estimatedCredits: number }>()).toMatchObject({
      status: "paused",
      estimatedCredits: 2,
    });
    expect(pool.paramsOf("INSERT INTO jobs")).toHaveLength(1);
    expect(pool.paramsOf("INSERT INTO jobs")[0]?.[5]).toBe("paused");
    expect(pool.paramsOf("INSERT INTO usage_ledger")).toHaveLength(0);
    expect(nc.published).toHaveLength(0);
  });

  it("leaves analysis alone", async () => {
    const { app, pool } = await build({ BRAGI_GPU_SECONDS_PER_DAY: "1" });
    pool.gpuSeconds = 1_000;
    const response = await app.inject(submit({ capability: "analysis.separation", params: {} }));
    expect(response.statusCode).toBe(202);
    expect(response.json<{ status: string }>().status).toBe("queued");
  });
});

describe("POST /v1/generations/warmup", () => {
  it("is disabled without a generation worker", async () => {
    const { app, pool } = await build();
    const response = await app.inject({ method: "POST", url: "/v1/generations/warmup" });

    expect(response.statusCode).toBe(202);
    expect(response.json<{ status: string }>().status).toBe("disabled");
    expect(pool.paramsOf("INSERT INTO jobs")).toHaveLength(0);
  });

  it("submits generate.warmup and answers warming", async () => {
    const { app, pool } = await build({ BRAGI_GENERATE_WORKERS: "1" });
    const response = await app.inject({ method: "POST", url: "/v1/generations/warmup" });

    expect(response.statusCode).toBe(202);
    expect(response.json<{ status: string }>().status).toBe("warming");
    const inserts = pool.paramsOf("INSERT INTO jobs");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.[3]).toBe("generate.warmup");
    expect(inserts[0]?.[5]).toBe("queued");
  });

  it("does not queue a second warm-up while one is in flight", async () => {
    const { app, pool } = await build({ BRAGI_GENERATE_WORKERS: "1" });
    pool.warmup = [{ status: "running", created_at: new Date(), finished_at: null }];
    const response = await app.inject({ method: "POST", url: "/v1/generations/warmup" });

    expect(response.json<{ status: string }>().status).toBe("warming");
    expect(pool.paramsOf("INSERT INTO jobs")).toHaveLength(0);
  });

  it("answers warm for a recent completion", async () => {
    const { app, pool } = await build({ BRAGI_GENERATE_WORKERS: "1" });
    pool.warmup = [
      { status: "done", created_at: new Date(Date.now() - 60_000), finished_at: new Date() },
    ];
    const response = await app.inject({ method: "POST", url: "/v1/generations/warmup" });

    expect(response.json<{ status: string }>().status).toBe("warm");
    expect(pool.paramsOf("INSERT INTO jobs")).toHaveLength(0);
  });

  it("re-submits after a stale completion", async () => {
    const { app, pool } = await build({ BRAGI_GENERATE_WORKERS: "1" });
    pool.warmup = [
      {
        status: "done",
        created_at: new Date(Date.now() - 3_600_000),
        finished_at: new Date(Date.now() - 3_600_000),
      },
    ];
    const response = await app.inject({ method: "POST", url: "/v1/generations/warmup" });

    expect(response.json<{ status: string }>().status).toBe("warming");
    expect(pool.paramsOf("INSERT INTO jobs")).toHaveLength(1);
  });

  it("shares one warm-up between concurrent pings", async () => {
    const pool = new FakePool();
    const nc = new FakeNats();
    const service = new WarmupService({
      config: config({ BRAGI_GENERATE_WORKERS: "1" }),
      pool: pool as unknown as AppContext["pool"],
      nc: nc as unknown as AppContext["nc"],
    });

    await expect(
      Promise.all([service.request("usr_1"), service.request("usr_2")]),
    ).resolves.toEqual(["warming", "warming"]);
    expect(pool.paramsOf("INSERT INTO jobs")).toHaveLength(1);
  });
});
