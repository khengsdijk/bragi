/**
 * Submit-time guards shared by the direct job route and plan execution
 * (specs/05-backend-and-jobs.md §6, §9).
 *
 * Both paths enqueue generation for a user, so both must check the same two
 * things: every input asset belongs to that user (the worker downloads by hash
 * without an ownership check), and the environment's daily GPU budget still has
 * room. Keeping them here means a new submit path cannot forget one.
 */
import type { AppContext } from "../app.js";
import { ApiError } from "../errors.js";
import { budgetExceeded, isGpuCapability } from "./budget.js";
import type { JobPriority } from "./service.js";

/**
 * A generation job may only read audio the user owns.
 *
 * Otherwise a guessed hash would let somebody generate from another user's audio
 * and then own the output (05 §6, §12).
 *
 * @throws ApiError `NOT_FOUND` for the first asset the user does not own
 */
export async function assertOwnsAssets(
  ctx: AppContext,
  userId: string,
  hashes: Iterable<string>,
): Promise<void> {
  for (const hash of hashes) {
    const { rowCount } = await ctx.pool.query(
      "SELECT 1 FROM user_assets WHERE user_id = $1 AND hash = $2",
      [userId, hash],
    );
    if (rowCount === null || rowCount === 0) throw new ApiError("NOT_FOUND", "asset not found");
  }
}

/**
 * Applies the daily GPU-seconds budget (05 §9).
 *
 * @returns whether the job may be enqueued; interactive generation past the cap
 *   throws `GENERATION_BUSY` instead of pausing, because the user is waiting
 */
export async function mayEnqueue(
  ctx: AppContext,
  capability: string,
  priority: JobPriority,
): Promise<boolean> {
  if (!isGpuCapability(capability)) return true;
  if (!(await budgetExceeded(ctx.pool, ctx.config))) return true;
  if (priority === "interactive") {
    throw new ApiError(
      "GENERATION_BUSY",
      "the daily GPU budget is spent; interactive generation resumes tomorrow",
    );
  }
  return false;
}
