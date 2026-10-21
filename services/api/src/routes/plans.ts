/**
 * `POST /v1/plans` (05 §2, 06 §2–§5, §8).
 *
 * The request carries the whole song document (docs/wp/2.6.md), so the route allows a larger body
 * than the JSON API default. It answers with an `EditPlan` or, for "Explain this", an
 * `Explanation`. A missing `OPENROUTER_API_KEY` is a clear 503 rather than a silent fallback.
 */

import { validatePlanRequest } from "@bragi/schemas";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app.js";
import { ApiError } from "../errors.js";
import { API_KEY_ENV, PlannerModelError, PlannerUnavailableError } from "../planner/openrouter.js";
import { createPlannerFromEnv, type PlannerService } from "../planner/planner.js";
import { requireSession } from "./guards.js";

/** A song document with analyses can be large; the default 1 MiB is not enough. */
export const PLANS_BODY_LIMIT = 8 * 1024 * 1024;

/** The production planner, built once per process (the environment does not change). */
let defaultPlanner: Promise<PlannerService> | undefined;

/** Registers `/v1/plans`. */
export function registerPlans(app: FastifyInstance, ctx: AppContext): void {
  app.post("/v1/plans", { bodyLimit: PLANS_BODY_LIMIT }, async (request) => {
    await requireSession(ctx.sessions, request);
    const planner = await plannerFor(ctx);
    const body: unknown = request.body;
    if (!validatePlanRequest(body)) {
      throw new ApiError("VALIDATION_FAILED", "the request body is not a valid PlanRequest");
    }
    try {
      return await planner.plan(body);
    } catch (error) {
      if (error instanceof PlannerUnavailableError) {
        throw new ApiError("PLANNER_UNAVAILABLE", error.message);
      }
      if (error instanceof PlannerModelError) {
        throw new ApiError(
          "MODEL_ERROR",
          error.retryable
            ? "The planner model is temporarily unavailable. Try again."
            : "The planner model could not answer that request.",
        );
      }
      throw error;
    }
  });
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
