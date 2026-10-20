/**
 * An `EditPlan` → one candidate `OpBatch` per variant (06 §3, §5; 02 §7).
 *
 * v1 plans are ops-only. Each variant's `ops` steps are concatenated in order into one batch, so
 * the candidate is instant and the Audition bar can compare it against HEAD. Variants that carry
 * only generation steps (WP-2.7 and later) are skipped; when nothing is left the prompt bar says
 * it could not find a way to do that here.
 */
import type { EditPlan, Explanation, Op, OpBatch } from "@bragi/schemas";

import { newBatchId } from "../song/state/ops.js";

/** The author model string for AI batches; the API does not expose the tier that answered. */
export const PLANNER_MODEL = "bragi-planner";

/** Whether the route answered with an Explanation instead of a plan (06 §8). */
export function isExplanation(value: EditPlan | Explanation): value is Explanation {
  return "text" in value && "highlights" in value;
}

/** Concatenates a variant's ops steps, ignoring the other step kinds v1 does not offer. */
export function opsForVariant(variant: EditPlan["variants"][number]): Op[] {
  return variant.steps.flatMap((step) => (step.kind === "ops" ? [...step.ops] : []));
}

/** A non-empty op tuple, or `null` when the variant has no instant steps. */
function opsTuple(ops: readonly Op[]): [Op, ...Op[]] | null {
  const [first, ...rest] = ops;
  return first === undefined ? null : [first, ...rest];
}

export interface CandidateBatchOptions {
  readonly prompt?: string;
  readonly now?: Date;
  readonly newId?: () => OpBatch["id"];
}

/**
 * One batch per variant that has instant ops. The batch label is the variant label, so the
 * version tree and the Audition bar show the planner's own words ("Dusty tape").
 */
export function candidateBatches(plan: EditPlan, options: CandidateBatchOptions = {}): OpBatch[] {
  const now = options.now ?? new Date();
  const newId = options.newId ?? newBatchId;
  const batches: OpBatch[] = [];
  for (const variant of plan.variants) {
    const ops = opsTuple(opsForVariant(variant));
    if (ops === null) continue;
    batches.push({
      id: newId(),
      author: { kind: "ai", planId: plan.planId, model: PLANNER_MODEL },
      ...(options.prompt === undefined ? {} : { intent: options.prompt }),
      label: variant.label,
      ops,
      createdAt: now.toISOString(),
    });
  }
  return batches;
}
