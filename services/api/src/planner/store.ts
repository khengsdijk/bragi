/**
 * Plans stored between propose and execute (06 §5).
 *
 * `POST /v1/plans` writes the plan it returns; `POST /v1/plans/{planId}/execute` reads it back
 * by id instead of taking the plan from the client. That choice is recorded in 06 §5 and
 * `docs/wp/2.8.md`: a stored plan cannot be tampered with between propose and execute, and the
 * client does not have to round-trip a whole plan it already has. The price is one row per plan;
 * the row is capped at {@link PLAN_TTL_HOURS} and expired rows are simply not read (a nightly GC
 * can delete them, they are not referenced by anything else).
 */
import type { EditPlan } from "@bragi/schemas";
import { validateEditPlan } from "@bragi/schemas";
import type { Pool } from "pg";

/** How long a proposed plan can be executed. */
export const PLAN_TTL_HOURS = 24;

/**
 * Stores one plan for this user.
 *
 * @param pool the database
 * @param userId the owner
 * @param plan the plan as it was returned to the client
 * @param now the proposal time (tests pass it)
 */
export async function savePlan(
  pool: Pool,
  userId: string,
  plan: EditPlan,
  now = new Date(),
): Promise<void> {
  const expiresAt = new Date(now.getTime() + PLAN_TTL_HOURS * 60 * 60 * 1000);
  await pool.query(
    `INSERT INTO plans (id, user_id, plan, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [plan.planId, userId, JSON.stringify(plan), now, expiresAt],
  );
}

/**
 * Reads one unexpired plan of this user.
 *
 * A row whose JSON no longer validates (a schema change between deploys) is treated as
 * missing: the client proposes again rather than executing half-understood steps.
 *
 * @returns the plan, or `undefined` when it does not exist, expired, or does not validate
 */
export async function loadPlan(
  pool: Pool,
  userId: string,
  planId: string,
  now = new Date(),
): Promise<EditPlan | undefined> {
  const { rows } = await pool.query<{ plan: unknown }>(
    "SELECT plan FROM plans WHERE id = $1 AND user_id = $2 AND expires_at > $3",
    [planId, userId, now],
  );
  const stored = rows[0]?.plan;
  return stored !== undefined && validateEditPlan(stored) ? stored : undefined;
}
