/**
 * The orchestrator's reaction to a job event (specs/05 §4.4).
 *
 * It records the result, then asks the DAG which dependents became ready and
 * enqueues them. The dependency logic itself is `jobs/dag.ts`; this module is
 * only the persistence around it.
 */
import type { JobEvent } from "@bragi/schemas";

import { readyStages } from "../jobs/dag.js";
import { type JobDeps, submitJob } from "../jobs/service.js";

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

/**
 * Applies one job event: updates the job row, and on completion records the
 * analysis result and enqueues dependents.
 */
export async function applyJobEvent(deps: JobDeps, event: JobEvent): Promise<void> {
  const status = STATUS_BY_EVENT[event.type];
  await deps.pool.query(
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

  if (event.type !== "completed") return;
  const { rows } = await deps.pool.query<JobRow>(
    "SELECT capability, user_id, params FROM jobs WHERE id = $1",
    [event.jobId],
  );
  const job = rows[0];
  if (!job?.capability.startsWith("analysis.")) return;
  const stage = job.capability.slice("analysis.".length);
  const assetHash = job.params?.assetHash;
  if (typeof assetHash !== "string") return;

  const blob = firstHash(event);
  await deps.pool.query(
    `UPDATE analyses SET status = 'done', blob_hash = COALESCE($3, blob_hash), updated_at = now()
     WHERE asset_hash = $1 AND stage = $2`,
    [assetHash, stage, blob],
  );
  await enqueueDependents(deps, assetHash, job.user_id);
}

/**
 * Publishes every pending analysis stage whose dependencies are complete.
 *
 * @returns the stages that were enqueued
 */
export async function enqueueDependents(
  deps: JobDeps,
  assetHash: string,
  userId: string,
): Promise<string[]> {
  const { rows } = await deps.pool.query<{ stage: string; done: boolean }>(
    `SELECT stage, bool_or(status = 'done') AS done
     FROM analyses WHERE asset_hash = $1 GROUP BY stage`,
    [assetHash],
  );
  const completed = new Set(rows.filter((row) => row.done).map((row) => row.stage));
  const pending = rows.filter((row) => !row.done).map((row) => row.stage);
  const ready = readyStages(completed, pending);
  for (const stage of ready) {
    await submitJob(deps, userId, {
      capability: `analysis.${stage}`,
      priority: "interactive",
      assets: { source: assetHash },
      params: { assetHash, stage },
    });
    await deps.pool.query(
      "UPDATE analyses SET status = 'queued', updated_at = now() WHERE asset_hash = $1 AND stage = $2",
      [assetHash, stage],
    );
  }
  return ready;
}

function firstHash(event: JobEvent): string | null {
  for (const source of [event.outputs?.blobs, event.outputs?.assets]) {
    const entry = source === undefined ? undefined : Object.values(source)[0];
    if (entry !== undefined) return entry;
  }
  return null;
}
