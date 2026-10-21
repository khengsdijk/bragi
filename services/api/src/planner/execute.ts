/**
 * `POST /v1/plans/{planId}/execute` (06 §5, 05 §2).
 *
 * The client has rendered and uploaded the context audio of every generate step; this module
 * re-checks the stored plan, charges the jobs, and submits one interactive job per generate step
 * of every chosen variant, so the variants' candidates generate in parallel. Ops and
 * `apply_generated` steps are the client's job: they become candidate commits when the partials
 * arrive.
 *
 * **Re-validation.** The plan is read from Postgres (it is not posted back, `store.ts`), so its
 * steps cannot have changed since validation. What is re-checked is what the client can influence
 * (the chosen variants and the context assets) and everything that does not need the song document:
 * the capability contract of each step, the step-id graph, the content policy on prompts, the
 * credits and the GPU budget. The document-dependent checks (region discipline, context ranges
 * inside the song, locked sections) ran at propose time.
 */
import type {
  EditPlan,
  GenerateStep,
  PlanExecuteRequest,
  PlanExecuteResponse,
  PlanVariant,
} from "@bragi/schemas";

import type { AppContext } from "../app.js";
import { ApiError } from "../errors.js";
import { isAssetHash } from "../ids.js";
import { capabilityParamsError, requiredInputAssets } from "../jobs/capabilities.js";
import {
  creditCharge,
  creditsConfig,
  creditsUsedToday,
  dailyCreditAllowance,
  fitsAllowance,
} from "../jobs/credits.js";
import { assertOwnsAssets, mayEnqueue } from "../jobs/guards.js";
import { type LedgerEntry, submitJob } from "../jobs/service.js";
import { isGenerationCapability } from "./generation.js";
import { blockedNamesIn } from "./policy.js";
import { loadPlan } from "./store.js";

/** One enqueued generate step. */
export interface ExecutedJob {
  readonly variant: number;
  readonly stepId: string;
  readonly jobId: string;
  readonly capability: string;
  readonly status: "queued" | "paused";
  readonly estimatedCredits: number;
}

/** A generate step with the variant it belongs to, ready to submit. */
interface PlannedStep {
  readonly variant: number;
  readonly step: GenerateStep;
}

/**
 * Executes the chosen variants of a stored plan.
 *
 * @param ctx the app context (database, bus, config)
 * @param userId the owner
 * @param planId the stored plan's id
 * @param request the chosen variants and the rendered context assets per step id
 * @returns one job per generate step of the chosen variants
 * @throws ApiError `NOT_FOUND` for an unknown plan or unowned asset, `VALIDATION_FAILED` for a
 *   bad variant index or missing context, `INSUFFICIENT_CREDITS` (402) and `GENERATION_BUSY` (503)
 */
export async function executePlan(
  ctx: AppContext,
  userId: string,
  planId: string,
  request: PlanExecuteRequest,
): Promise<PlanExecuteResponse> {
  const plan = await loadPlan(ctx.pool, userId, planId);
  if (plan === undefined) {
    throw new ApiError(
      "NOT_FOUND",
      "no executable plan with that id (plans can be executed for 24 hours after they are proposed)",
    );
  }

  const indexes = chosenVariants(plan, request.variants);
  const steps: PlannedStep[] = [];
  const seen = new Set<string>();
  for (const index of indexes) {
    const variant = plan.variants[index];
    if (variant === undefined) continue;
    for (const step of variant.steps) {
      if (step.kind !== "generate") continue;
      if (seen.has(step.id)) {
        throw new ApiError(
          "VALIDATION_FAILED",
          `generate step "${step.id}" appears in more than one chosen variant; contexts are keyed by step id`,
        );
      }
      seen.add(step.id);
      steps.push({ variant: index, step });
    }
  }
  if (steps.length === 0) {
    // The chosen variants are ops-only: their steps apply in the client, so there is nothing to
    // enqueue. That is a success, not an error, for a client that posts every variant index.
    return { jobs: [] };
  }
  for (const planned of steps) {
    const variant = plan.variants[planned.variant];
    if (variant !== undefined) revalidateStep(planned.step, variant);
  }
  const assets = contextAssets(steps, request);

  const credits = creditsConfig(ctx.config.creditsConfig);
  const charges = steps.map((planned) => ({
    ...planned,
    charge: creditCharge(planned.step.capability, planned.step.params, credits).credits,
  }));
  const total = charges.reduce((sum, planned) => sum + planned.charge, 0);
  if (total > 0) {
    const allowance = dailyCreditAllowance(ctx.config, credits);
    const used = await creditsUsedToday(ctx.pool, userId);
    if (!fitsAllowance(used, allowance, total)) {
      throw new ApiError("INSUFFICIENT_CREDITS", "not enough credits to execute this plan today", {
        required: total,
        used,
        allowance: allowance ?? null,
      });
    }
  }

  // Resolve the budget for every capability before the first submit, so a spent budget cannot
  // leave half of a plan enqueued (05 §9).
  for (const capability of new Set(charges.map((planned) => planned.step.capability))) {
    await mayEnqueue(ctx, capability, "interactive");
  }
  await assertOwnsAssets(ctx, userId, Object.values(assets).flatMap(Object.values));

  const jobs: ExecutedJob[] = [];
  for (const planned of charges) {
    const ledger: LedgerEntry | undefined =
      planned.charge > 0
        ? {
            credits: planned.charge,
            capability: planned.step.capability,
            ...(typeof planned.step.params.tier === "string"
              ? { tier: planned.step.params.tier }
              : {}),
            reason: `${planned.step.capability} plan ${plan.planId}`,
          }
        : undefined;
    const { job, status } = await submitJob(
      ctx,
      userId,
      {
        capability: planned.step.capability,
        priority: "interactive",
        assets: assets[planned.step.id] ?? {},
        params: planned.step.params,
        context: { planId: plan.planId, stepId: planned.step.id, variant: planned.variant },
      },
      ledger === undefined ? {} : { ledger },
    );
    jobs.push({
      variant: planned.variant,
      stepId: planned.step.id,
      jobId: job.jobId,
      capability: planned.step.capability,
      status,
      estimatedCredits: planned.charge,
    });
  }
  return { jobs };
}

/**
 * The variant indexes to run.
 *
 * The default is every variant that has a generate step: an ops-only variant has nothing to
 * enqueue, and asking for it is not an error.
 *
 * @throws ApiError `VALIDATION_FAILED` for an index the plan does not have
 */
export function chosenVariants(plan: EditPlan, requested: readonly number[] | undefined): number[] {
  const withGeneration = plan.variants
    .map((variant, index) => (variant.steps.some((step) => step.kind === "generate") ? index : -1))
    .filter((index) => index >= 0);
  if (requested === undefined) return withGeneration;
  const unique = [...new Set(requested)];
  for (const index of unique) {
    if (plan.variants[index] === undefined) {
      throw new ApiError("VALIDATION_FAILED", `variant ${index} does not exist in this plan`);
    }
  }
  return unique.filter((index) => withGeneration.includes(index));
}

/**
 * Re-checks the parts of a generate step that do not need the song document.
 *
 * @throws ApiError `VALIDATION_FAILED` naming the step
 */
function revalidateStep(step: GenerateStep, variant: PlanVariant): void {
  const context: string[] = [];
  if (!isGenerationCapability(step.capability)) {
    context.push(`capability "${step.capability}" is not executable`);
  }
  const paramsError = capabilityParamsError(step.capability, step.params);
  if (paramsError !== undefined) context.push(paramsError);
  for (const prompt of [step.params.prompt]) {
    if (typeof prompt === "string" && blockedNamesIn(prompt).length > 0) {
      throw new ApiError("PROMPT_POLICY", "a generation prompt names an artist or song");
    }
  }
  const generatedIds = new Set(
    variant.steps
      .filter((candidate) => candidate.kind === "generate")
      .map((candidate) => candidate.id),
  );
  const applied = new Set(
    variant.steps.flatMap((candidate) =>
      candidate.kind === "apply_generated" ? [candidate.from] : [],
    ),
  );
  if (!generatedIds.has(step.id))
    context.push(`generate step "${step.id}" is not part of its variant`);
  if (!applied.has(step.id)) context.push(`generate step "${step.id}" has no apply_generated`);
  if (context.length > 0) {
    throw new ApiError("VALIDATION_FAILED", `generate step "${step.id}": ${context.join("; ")}`);
  }
}

/**
 * The context assets the client rendered, keyed by step id.
 *
 * A capability's input keys are fixed (`context` for an extend, `before` and `after` for the
 * two-sided capabilities), so a missing or extra key is a client bug worth a 400.
 *
 * @throws ApiError `VALIDATION_FAILED` for a step without its assets
 */
function contextAssets(
  steps: readonly PlannedStep[],
  request: PlanExecuteRequest,
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const { step } of steps) {
    const provided: Record<string, unknown> = Object.fromEntries(
      Object.entries(request.contexts[step.id] ?? {}),
    );
    const required = requiredInputAssets(step.capability);
    const missing = required.filter((key) => provided[key] === undefined);
    if (missing.length > 0) {
      throw new ApiError(
        "VALIDATION_FAILED",
        `contexts.${step.id} needs the rendered ${missing.join(" and ")} audio of this step`,
        { stepId: step.id, capability: step.capability },
      );
    }
    const extra = Object.keys(provided).filter((key) => !required.includes(key));
    if (extra.length > 0) {
      throw new ApiError(
        "VALIDATION_FAILED",
        `contexts.${step.id} has ${extra.join(", ")}, which ${step.capability} does not take`,
        { stepId: step.id },
      );
    }
    const assets: Record<string, string> = {};
    for (const key of required) {
      const hash = provided[key];
      if (typeof hash !== "string" || !isAssetHash(hash)) {
        throw new ApiError(
          "VALIDATION_FAILED",
          `contexts.${step.id}.${key} must be an asset hash`,
          {
            stepId: step.id,
          },
        );
      }
      assets[key] = hash;
    }
    out[step.id] = assets;
  }
  return out;
}
