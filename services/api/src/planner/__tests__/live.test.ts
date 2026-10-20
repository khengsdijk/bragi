/**
 * The one test that touches the real OpenRouter API.
 *
 * Skipped unless `OPENROUTER_API_KEY` is set **and** `BRAGI_PLANNER_LIVE=1`, so `pnpm test` never
 * spends credits. It asks for a single ops-only plan on the planner fixture; it needs the
 * `summarizeForLlm` export from WP-2.6 task A.
 */
import { describe, expect, it } from "vitest";

import { createPlannerFromEnv } from "../planner.js";
import { testRequest } from "./fixtures.js";

const live =
  (process.env.OPENROUTER_API_KEY ?? "") !== "" && process.env.BRAGI_PLANNER_LIVE === "1";

describe.skipIf(!live)("planner against OpenRouter", () => {
  it("produces an ops-only plan", async () => {
    const planner = await createPlannerFromEnv();
    const plan = await planner.plan(testRequest());
    if (!("variants" in plan)) throw new Error("expected an EditPlan");
    expect(plan.variants.length).toBeGreaterThanOrEqual(1);
    expect(plan.estimatedCredits).toBe(0);
  }, 60_000);
});
