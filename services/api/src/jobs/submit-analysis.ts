/**
 * The one place an analysis profile becomes jobs (specs/04 §2–§3, 05 §4.4).
 *
 * `POST /analyses` and `POST /library/import` both reach it, so the DAG gating,
 * the idempotency rule and the stage-input wiring cannot drift between them.
 */
import type { Pool } from "pg";

import { type AnalysisProfile, implementedStagesForProfile, readyStages } from "./dag.js";
import { type JobDeps, submitJob } from "./service.js";
import { loadStageResults, resolveStageInputs } from "./stage-inputs.js";

/**
 * Placeholder stage version. Every analysis stage has its own real version
 * (`separation@htdemucs_6s-1`, 04 §1) once the stage exists in WP-1.2+.
 */
export const STAGE_VERSION = "v0";

/** A stage that has not run yet, or that a client may retry. */
export function isActionable(status: string | undefined): boolean {
  return status === undefined || status === "pending" || status === "failed";
}

export interface AnalysisPlan {
  /** Stages with no `analyses` row yet; the caller inserts them as `pending`. */
  readonly toCreate: readonly string[];
  /** Stages to submit now (actionable, dependencies done), in DAG order. */
  readonly toSubmit: readonly string[];
}

/**
 * Which stages a request should create and submit, given the statuses the
 * database already holds. Pure, so the idempotency rule is testable without a
 * pool: a stage that is already `queued`, `running` or `done` is never
 * actionable, so a repeated call submits nothing.
 *
 * @param stages the implemented stages of the requested profile, in DAG order
 * @param status current `analyses.status` per stage
 */
export function planAnalyses(
  stages: readonly string[],
  status: ReadonlyMap<string, string>,
): AnalysisPlan {
  const done = new Set(stages.filter((stage) => status.get(stage) === "done"));
  // Everything not done is "still in the run", including queued/running stages:
  // a dependent must wait for them, and they must not be submitted again.
  const waiting = stages.filter((stage) => !done.has(stage));
  const toCreate = stages.filter((stage) => status.get(stage) === undefined);
  const toSubmit = readyStages(done, waiting).filter((stage) => isActionable(status.get(stage)));
  return { toCreate, toSubmit };
}

/** The status per stage for one asset, as `planAnalyses` needs it. */
export async function statusForAsset(pool: Pool, assetHash: string): Promise<Map<string, string>> {
  const { rows } = await pool.query<{ stage: string; status: string }>(
    "SELECT stage, status FROM analyses WHERE asset_hash = $1",
    [assetHash],
  );
  return new Map(rows.map((row) => [row.stage, row.status]));
}

/**
 * Creates the missing `analyses` rows and publishes the ready stages.
 *
 * Idempotent and safe to call twice: `planAnalyses` skips anything already
 * queued/running/done, the insert is `ON CONFLICT DO NOTHING`, and a stage is
 * only marked `queued` after its job is published.
 *
 * @returns the stages that were enqueued
 */
export async function submitAnalysis(
  deps: JobDeps,
  userId: string,
  assetHash: string,
  profile: AnalysisProfile,
): Promise<string[]> {
  const stages = implementedStagesForProfile(profile);
  const plan = planAnalyses(stages, await statusForAsset(deps.pool, assetHash));

  for (const stage of plan.toCreate) {
    await deps.pool.query(
      `INSERT INTO analyses (asset_hash, stage, stage_version, status)
       VALUES ($1, $2, $3, 'pending')
       ON CONFLICT (asset_hash, stage, stage_version) DO NOTHING`,
      [assetHash, stage, STAGE_VERSION],
    );
  }

  if (plan.toSubmit.length === 0) return [];
  // Inputs come from the stages already finished: cached results are reused
  // (04 §1.2), so a late stage still gets its stems and blobs.
  const results = await loadStageResults(deps.pool, assetHash);
  for (const stage of plan.toSubmit) {
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
      `UPDATE analyses SET status = 'queued', updated_at = now()
       WHERE asset_hash = $1 AND stage = $2 AND stage_version = $3`,
      [assetHash, stage, STAGE_VERSION],
    );
  }
  return [...plan.toSubmit];
}
