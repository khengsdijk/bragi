import { describe, expect, it } from "vitest";

import { implementedStagesForProfile } from "../jobs/dag.js";
import { planAnalyses } from "../jobs/submit-analysis.js";

const STANDARD = implementedStagesForProfile("standard");

describe("planAnalyses (finding 4: POST /analyses is idempotent)", () => {
  it("submits only ingest on a fresh asset", () => {
    const plan = planAnalyses(STANDARD, new Map());
    expect(plan.toCreate).toEqual(STANDARD);
    expect(plan.toSubmit).toEqual(["ingest"]);
  });

  it("submits nothing when a call is repeated while ingest is queued", () => {
    const status = new Map(STANDARD.map((stage) => [stage, "pending"]));
    status.set("ingest", "queued");
    const plan = planAnalyses(STANDARD, status);
    expect(plan.toCreate).toEqual([]);
    expect(plan.toSubmit).toEqual([]);
  });

  it("submits nothing when every stage is queued, running or done", () => {
    const status = new Map(
      STANDARD.map((stage, index) => [stage, index % 2 === 0 ? "queued" : "running"]),
    );
    expect(planAnalyses(STANDARD, status).toSubmit).toEqual([]);

    const done = new Map(STANDARD.map((stage) => [stage, "done"]));
    expect(planAnalyses(STANDARD, done).toSubmit).toEqual([]);
  });

  it("releases exactly the dependents whose dependencies are done", () => {
    const status = new Map(STANDARD.map((stage) => [stage, "pending"]));
    status.set("ingest", "done");
    expect(new Set(planAnalyses(STANDARD, status).toSubmit)).toEqual(
      new Set(["rhythm", "loudness_energy", "embed_full", "separation"]),
    );
  });

  it("retries a failed stage once its dependencies are done", () => {
    const status = new Map(STANDARD.map((stage) => [stage, "pending"]));
    status.set("ingest", "done");
    status.set("rhythm", "failed");
    expect(planAnalyses(STANDARD, status).toSubmit).toContain("rhythm");
  });

  it("leaves a failed stage alone while a dependency is still pending", () => {
    const status = new Map(STANDARD.map((stage) => [stage, "pending"]));
    status.set("ingest", "queued");
    status.set("rhythm", "failed");
    expect(planAnalyses(STANDARD, status).toSubmit).toEqual([]);
  });
});
