/**
 * An `EditPlan` → one candidate `OpBatch` per ops-only variant (06 §3, §5; 02 §7).
 *
 * Each variant's `ops` steps are concatenated in order into one batch, so the candidate is instant
 * and the Audition bar can compare it against HEAD. A variant with a `generate` step is not here:
 * `planner-generation.ts` builds its candidate when the job's first passing partial arrives, because
 * a candidate is a document snapshot and its placement only exists then.
 */
import type { EditPlan, Explanation, Op, OpBatch } from "@bragi/schemas";

import { newBatchId } from "../song/state/ops.js";

/** The author model string for AI batches; the API does not expose the tier that answered. */
export const PLANNER_MODEL = "bragi-planner";

/** Whether the route answered with an Explanation instead of a plan (06 §8). */
export function isExplanation(value: EditPlan | Explanation): value is Explanation {
  return "text" in value && "highlights" in value;
}

/** Concatenates a variant's ops steps. */
export function opsForVariant(variant: EditPlan["variants"][number]): Op[] {
  return variant.steps.flatMap((step) => (step.kind === "ops" ? [...step.ops] : []));
}

/** Whether a variant needs a generation job before it can become a candidate. */
export function isGenerativeVariant(variant: EditPlan["variants"][number]): boolean {
  return variant.steps.some((step) => step.kind === "generate");
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
    if (isGenerativeVariant(variant)) continue;
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
