/**
 * The global GPU-seconds budget (specs/05-backend-and-jobs.md §9).
 *
 * Cost is the core business risk (R6), so one cap per environment is checked at
 * submit: past it, interactive generation is refused with `GENERATION_BUSY` and
 * background generation is not enqueued. The spend is the `gpuSeconds` metric the
 * worker records on `completed` (05 §4.2), summed over the UTC day, so a restarted
 * API cannot forget it.
 */
import type { Pool } from "pg";

import type { Config } from "../config.js";

/** True for the capabilities the GPU budget guards (05 §9, 09 §1). */
export function isGpuCapability(capability: string): boolean {
  return (
    capability.startsWith("generate.") ||
    capability.startsWith("transform.") ||
    capability.startsWith("fusion.")
  );
}

/** GPU seconds the environment spent since the start of the UTC day. */
export async function gpuSecondsToday(pool: Pool, now = new Date()): Promise<number> {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const { rows } = await pool.query<{ seconds: number }>(
    `SELECT COALESCE(SUM(gpu_seconds), 0)::float8 AS seconds
     FROM jobs WHERE finished_at >= $1 AND gpu_seconds IS NOT NULL`,
    [start],
  );
  return rows[0]?.seconds ?? 0;
}

/**
 * Whether today's spend already reached the cap.
 *
 * @returns `false` when `BRAGI_GPU_SECONDS_PER_DAY` is unset: no cap is the rule in
 *   local development and single-user mode
 */
export async function budgetExceeded(
  pool: Pool,
  config: Config,
  now = new Date(),
): Promise<boolean> {
  const cap = config.gpuSecondsPerDay;
  if (cap === undefined) return false;
  return (await gpuSecondsToday(pool, now)) >= cap;
}
