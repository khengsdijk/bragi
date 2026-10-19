import type { JobEvent } from "@bragi/schemas";
import type { NatsConnection } from "nats";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { applyJobEvent } from "../orchestrator/handler.js";

interface Query {
  readonly sql: string;
  readonly params?: readonly unknown[];
}

interface AnalysisRow {
  stage: string;
  done: boolean;
}

/** The handful of statements the handler issues, answered from canned state. */
class FakePool {
  readonly queries: Query[] = [];
  job: { capability: string; user_id: string; params: Record<string, unknown> } | undefined;
  analysisRows: AnalysisRow[] = [];

  async query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: unknown[]; rowCount: number }> {
    this.queries.push({ sql, params });
    if (sql.includes("SELECT capability, user_id, params FROM jobs")) {
      return { rows: this.job ? [this.job] : [], rowCount: this.job ? 1 : 0 };
    }
    if (sql.includes("SELECT stage, bool_or")) {
      return { rows: this.analysisRows, rowCount: this.analysisRows.length };
    }
    if (sql.includes("SELECT stage, blob_hash FROM analyses")) {
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 1 };
  }
}

class FakeNats {
  readonly published: { subject: string; payload: unknown }[] = [];
  publish(subject: string, data: Uint8Array): void {
    this.published.push({ subject, payload: JSON.parse(new TextDecoder().decode(data)) });
  }
}

function completed(partial: Partial<JobEvent> = {}): JobEvent {
  return { schemaVersion: 1, jobId: "job_01", type: "completed", ...partial } as JobEvent;
}

function deps(pool: FakePool, nc: FakeNats) {
  return { pool: pool as unknown as Pool, nc: nc as unknown as NatsConnection };
}

describe("applyJobEvent (findings 2 and 3)", () => {
  it("records the working asset and the result blob as derived, then publishes the partial", async () => {
    const pool = new FakePool();
    pool.job = {
      capability: "analysis.ingest",
      user_id: "usr_1",
      params: { assetHash: "sha256:aa", stage: "ingest" },
    };
    pool.analysisRows = [{ stage: "ingest", done: true }];
    const nc = new FakeNats();

    await applyJobEvent(
      deps(pool, nc),
      completed({
        outputs: {
          assets: { workingAsset: "sha256:bb" },
          blobs: { result: "sha256:cc" },
        },
      }),
    );

    const derived = pool.queries
      .filter((query) => query.sql.includes("INSERT INTO user_assets"))
      .map((query) => (query.params as string[])[1]);
    expect(new Set(derived)).toEqual(new Set(["sha256:bb", "sha256:cc"]));

    expect(nc.published).toEqual([
      {
        subject: "events.asset.sha256:aa",
        payload: {
          assetHash: "sha256:aa",
          type: "analysis.partial",
          stage: "ingest",
          blob: "sha256:cc",
        },
      },
    ]);
  });

  it("publishes analysis.failed when a stage fails", async () => {
    const pool = new FakePool();
    pool.job = {
      capability: "analysis.harmony",
      user_id: "usr_1",
      params: { assetHash: "sha256:aa", stage: "harmony" },
    };
    const nc = new FakeNats();

    await applyJobEvent(
      deps(pool, nc),
      completed({
        type: "failed",
        error: { code: "MODEL_ERROR", message: "no chords", retryable: false },
      }),
    );

    expect(nc.published).toEqual([
      {
        subject: "events.asset.sha256:aa",
        payload: {
          assetHash: "sha256:aa",
          type: "analysis.failed",
          stage: "harmony",
          error: { code: "MODEL_ERROR", message: "no chords", retryable: false },
        },
      },
    ]);
    const failed = pool.queries.find((query) => query.sql.includes("status = 'failed'"));
    expect(failed?.params).toEqual([
      "sha256:aa",
      "harmony",
      JSON.stringify({ code: "MODEL_ERROR", message: "no chords", retryable: false }),
    ]);
  });

  it("ignores a non-analysis job", async () => {
    const pool = new FakePool();
    pool.job = { capability: "echo", user_id: "usr_1", params: {} };
    const nc = new FakeNats();
    await applyJobEvent(deps(pool, nc), completed());
    expect(nc.published).toEqual([]);
  });
});
