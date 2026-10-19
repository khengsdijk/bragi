/**
 * The orchestrator's reaction to a job event (specs/05 §4.4).
 *
 * It records the result, then asks the DAG which dependents became ready and
 * enqueues them. The dependency logic itself is `jobs/dag.ts`; this module is
 * only the persistence around it.
 *
 * Three things it owns beyond the DAG:
 *
 * - **Ownership.** Every hash a worker produced (a stem, the working asset, a
 *   result blob) is recorded in `assets` and `user_assets (role = 'derived')`,
 *   so `GET /assets/{hash}/url` and an `asset:<hash>` subscription work for the
 *   client that asked for the analysis (finding 3).
 * - **Fan-out.** A finished stage publishes `analysis.partial` on
 *   `events.asset.<uploadHash>` (and `analysis.failed` on failure), which the
 *   gateway forwards to `asset:<uploadHash>` subscribers (finding 2).
 * - **Input wiring.** Dependents are submitted through
 *   {@link resolveStageInputs}, so they get their stems and blobs (finding 1).
 */
import type { JobEvent } from "@bragi/schemas";
import type { Pool } from "pg";

import { IMPLEMENTED_STAGES, readyStages } from "../jobs/dag.js";
import { type JobDeps, submitJob } from "../jobs/service.js";
import {
  loadStageResults,
  resolveStageInputs,
  resultBlob,
  type StageAssets,
} from "../jobs/stage-inputs.js";
import { assetEventSubject } from "../nats/client.js";

/** Job status written for each event type (05 §2 `GET /jobs/{id}`). */
const STATUS_BY_EVENT: Record<JobEvent["type"], string> = {
  started: "running",
  progress: "running",
  partial: "running",
  completed: "done",
  failed: "failed",
};

interface JobRow {
  capability: string;
  user_id: string;
  params: Record<string, unknown> | null;
}

/** The `analysis.<stage>` a capability names, or `undefined` for a non-analysis job. */
export function analysisStageOf(capability: string): string | undefined {
  return capability.startsWith("analysis.") ? capability.slice("analysis.".length) : undefined;
}

/**
 * Applies one job event: updates the job row, and on completion records the
 * analysis result, grants the outputs to the user and enqueues dependents. A
 * failed analysis stage publishes `analysis.failed` and marks the row failed.
 */
export async function applyJobEvent(deps: JobDeps, event: JobEvent): Promise<void> {
  await updateJob(deps.pool, event);

  const job = await loadJob(deps.pool, event.jobId);
  const stage = job === undefined ? undefined : analysisStageOf(job.capability);
  if (job === undefined || stage === undefined) return;
  const assetHash = job.params?.assetHash;
  if (typeof assetHash !== "string") return;
  const userId = job.user_id;

  if (event.type === "completed") {
    await recordOutputs(deps.pool, userId, event.outputs);
    const blob = resultBlob(stage, event.outputs);
    await deps.pool.query(
      `UPDATE analyses SET status = 'done', blob_hash = COALESCE($3, blob_hash), updated_at = now()
       WHERE asset_hash = $1 AND stage = $2`,
      [assetHash, stage, blob ?? null],
    );
    if (blob !== undefined) {
      await publishAnalysisEvent(deps, assetHash, { type: "analysis.partial", stage, blob });
    }
    await enqueueDependents(deps, assetHash, userId);
    return;
  }

  if (event.type === "failed") {
    const error = event.error ?? { code: "MODEL_ERROR", message: "stage failed", retryable: false };
    await deps.pool.query(
      `UPDATE analyses SET status = 'failed', error = $3, updated_at = now()
       WHERE asset_hash = $1 AND stage = $2`,
      [assetHash, stage, JSON.stringify(error)],
    );
    await publishAnalysisEvent(deps, assetHash, {
      type: "analysis.failed",
      stage,
      error: { code: error.code, message: error.message, retryable: error.retryable },
    });
  }
}

async function updateJob(pool: Pool, event: JobEvent): Promise<void> {
  const status = STATUS_BY_EVENT[event.type];
  await pool.query(
    `UPDATE jobs
     SET status = $2,
         outputs = COALESCE($3, outputs),
         error = COALESCE($4, error),
         gpu_seconds = COALESCE($5, gpu_seconds),
         finished_at = CASE WHEN $2 IN ('done', 'failed') THEN now() ELSE finished_at END
     WHERE id = $1`,
    [
      event.jobId,
      status,
      event.outputs === undefined ? null : JSON.stringify(event.outputs),
      event.error === undefined ? null : JSON.stringify(event.error),
      event.metrics?.gpuSeconds ?? null,
    ],
  );
}

async function loadJob(pool: Pool, jobId: string): Promise<JobRow | undefined> {
  const { rows } = await pool.query<JobRow>(
    "SELECT capability, user_id, params FROM jobs WHERE id = $1",
    [jobId],
  );
  return rows[0];
}

/**
 * Records every hash a worker produced against the owning user (05 §5, §6).
 *
 * `assets` is inserted first because `user_assets.hash` references it; the mime
 * and size of a derived asset are not known here, so both stay null. A hash the
 * user already owns (the upload itself, or a cached stage two users share) is
 * left as it is.
 */
export async function recordOutputs(
  pool: Pool,
  userId: string,
  outputs: { assets?: StageAssets; blobs?: StageAssets } | undefined,
): Promise<string[]> {
  const hashes = new Set<string>();
  for (const source of [outputs?.assets, outputs?.blobs]) {
    if (source === undefined) continue;
    for (const hash of Object.values(source)) hashes.add(hash);
  }
  for (const hash of hashes) {
    await pool.query("INSERT INTO assets (hash) VALUES ($1) ON CONFLICT (hash) DO NOTHING", [hash]);
    await pool.query(
      `INSERT INTO user_assets (user_id, hash, role) VALUES ($1, $2, 'derived')
       ON CONFLICT (user_id, hash) DO NOTHING`,
      [userId, hash],
    );
  }
  return [...hashes];
}

/** The payload the gateway reads off `events.asset.<hash>` (05 §3). */
export type AnalysisAssetEvent =
  | { type: "analysis.partial"; stage: string; blob: string }
  | {
      type: "analysis.failed";
      stage: string;
      error: { code: string; message: string; retryable: boolean };
    };

async function publishAnalysisEvent(
  deps: JobDeps,
  assetHash: string,
  payload: AnalysisAssetEvent,
): Promise<void> {
  const body = JSON.stringify({ assetHash, ...payload });
  deps.nc.publish(assetEventSubject(assetHash), new TextEncoder().encode(body));
}

/**
 * Publishes every actionable analysis stage whose dependencies are complete.
 *
 * @returns the stages that were enqueued
 */
export async function enqueueDependents(
  deps: JobDeps,
  assetHash: string,
  userId: string,
): Promise<string[]> {
  // Only stages still `pending` are candidates: a stage that is queued, running or
  // failed must not be submitted again by every completion that follows (a retry is
  // the client calling POST /analyses, 04 §2).
  const { rows } = await deps.pool.query<{ stage: string; done: boolean; waiting: boolean }>(
    `SELECT stage, bool_or(status = 'done') AS done, bool_and(status = 'pending') AS waiting
     FROM analyses WHERE asset_hash = $1 GROUP BY stage`,
    [assetHash],
  );
  const completed = new Set(rows.filter((row) => row.done).map((row) => row.stage));
  const pending = rows
    .filter((row) => !row.done && row.waiting)
    .map((row) => row.stage)
    .filter((stage) => IMPLEMENTED_STAGES.has(stage));
  const ready = readyStages(completed, pending);
  if (ready.length === 0) return [];

  const results = await loadStageResults(deps.pool, assetHash);
  for (const stage of ready) {
    const inputs = resolveStageInputs(assetHash, stage, results);
    await submitJob(deps, userId, {
      capability: `analysis.${stage}`,
      priority: "interactive",
      assets: inputs.assets,
      blobs: inputs.blobs,
      params: {},
      context: { assetHash, stage },
    });
    await deps.pool.query(
      "UPDATE analyses SET status = 'queued', updated_at = now() WHERE asset_hash = $1 AND stage = $2",
      [assetHash, stage],
    );
  }
  return ready;
}
