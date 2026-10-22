/**
 * `/v1/plans` (05 §2, 06 §2–§5, §8).
 *
 * `POST /v1/plans` carries the whole song document (docs/wp/2.6.md), so the route allows a larger
 * body than the JSON API default. It answers with an `EditPlan` or, for "Explain this", an
 * `Explanation`; a plan with variants is stored so it can be executed (`store.ts`). A missing
 * `OPENROUTER_API_KEY` is a clear 503 rather than a silent fallback.
 *
 * `POST /v1/plans/{planId}/execute` runs the chosen variants' generate steps as interactive jobs
 * and returns their job ids (06 §5). The plan is read from storage, never from the client.
 */

import {
  type EditPlan,
  type Explanation,
  type PlanExecuteRequest,
  validatePlanExecuteRequest,
  validatePlanRequest,
} from "@bragi/schemas";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app.js";
import { ApiError } from "../errors.js";
import { creditsConfig, creditsUsedToday, dailyCreditAllowance } from "../jobs/credits.js";
import { executePlan } from "../planner/execute.js";
import { API_KEY_ENV, PlannerModelError, PlannerUnavailableError } from "../planner/openrouter.js";
import { createPlannerFromEnv, type PlannerService } from "../planner/planner.js";
import { savePlan } from "../planner/store.js";
import { pathParam, requireSession } from "./guards.js";

/** A song document with analyses can be large; the default 1 MiB is not enough. */
export const PLANS_BODY_LIMIT = 8 * 1024 * 1024;

/** The production planner, built once per process (the environment does not change). */
let defaultPlanner: Promise<PlannerService> | undefined;

/** Registers `/v1/plans` and `/v1/plans/:planId/execute`. */
export function registerPlans(app: FastifyInstance, ctx: AppContext): void {
  app.post("/v1/plans", { bodyLimit: PLANS_BODY_LIMIT }, async (request) => {
    const session = await requireSession(ctx.sessions, request);
    const planner = await plannerFor(ctx);
    const body: unknown = request.body;
    if (!validatePlanRequest(body)) {
      throw new ApiError("VALIDATION_FAILED", "the request body is not a valid PlanRequest");
    }
    const remaining = await remainingCreditsFor(ctx, session.user.id);
    let result: EditPlan | Explanation;
    try {
      result = await planner.plan(body, { remainingCredits: remaining });
    } catch (error) {
      if (error instanceof ApiError && error.code === "PLAN_INVALID") {
        request.log.warn({ code: error.code, details: error.details }, "plan rejected");
      }
      throw plannerError(error);
    }
    if ("variants" in result && result.variants.length > 0) {
      await savePlan(ctx.pool, session.user.id, result);
    }
    return result;
  });

  app.post<{ Body: PlanExecuteRequest }>("/v1/plans/:planId/execute", async (request) => {
    const session = await requireSession(ctx.sessions, request);
    const body: unknown = request.body ?? { contexts: {} };
    if (!validatePlanExecuteRequest(body)) {
      throw new ApiError(
        "VALIDATION_FAILED",
        firstIssue(validatePlanExecuteRequest.errors) ??
          "the request body is not a PlanExecuteRequest (contexts per generate step id)",
      );
    }
    return executePlan(ctx, session.user.id, pathParam(request, "planId"), body);
  });
}

/** The first schema issue as `path: message`, so a client sees which field is wrong. */
function firstIssue(
  errors: readonly { instancePath?: string; message?: string }[] | null | undefined,
): string | undefined {
  const issue = errors?.[0];
  if (issue === undefined) return undefined;
  const path = (issue.instancePath ?? "").replace(/^\//, "").replaceAll("/", ".");
  return `${path === "" ? "body" : path}: ${issue.message ?? "is invalid"}`;
}

/** Maps planner failures onto the 05 §2 error envelope. */
function plannerError(error: unknown): Error {
  if (error instanceof PlannerUnavailableError) {
    return new ApiError("PLANNER_UNAVAILABLE", error.message);
  }
  if (error instanceof PlannerModelError) {
    return new ApiError(
      "MODEL_ERROR",
      error.retryable
        ? "The planner model is temporarily unavailable. Try again."
        : "The planner model could not answer that request.",
    );
  }
  return error instanceof Error ? error : new ApiError("INTERNAL", "internal error");
}

/**
 * The credits the user can still spend today, or `undefined` when unlimited.
 *
 * Passed into the planner so an over-budget plan gets its one repair round with the real number
 * (06 §5) instead of failing after the user has waited for it.
 */
async function remainingCreditsFor(ctx: AppContext, userId: string): Promise<number | undefined> {
  const credits = creditsConfig(ctx.config.creditsConfig);
  const allowance = dailyCreditAllowance(ctx.config, credits);
  if (allowance === undefined) return undefined;
  return Math.max(0, allowance - (await creditsUsedToday(ctx.pool, userId)));
}

/** The injected planner in tests, or the one built from the environment. */
async function plannerFor(ctx: AppContext): Promise<PlannerService> {
  if (ctx.planner !== undefined) return ctx.planner;
  if ((process.env[API_KEY_ENV] ?? "") === "") {
    throw new ApiError(
      "PLANNER_UNAVAILABLE",
      `${API_KEY_ENV} is not set, so the planner cannot run.`,
    );
  }
  defaultPlanner ??= createPlannerFromEnv();
  return defaultPlanner;
}
