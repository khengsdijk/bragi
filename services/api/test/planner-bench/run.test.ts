import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  BENCH_DIR,
  computeMetrics,
  loadCases,
  loadFixture,
  parseArgs,
  runBench,
  selectCases,
} from "./run.js";

/** The three cases recorded for the offline smoke test. */
const SMOKE_CASES = ["arr-remove-section", "mix-mute-texture", "policy-jackson"];

describe("bench cases and fixtures", () => {
  it("loads a fixture that passes the document schema", () => {
    expect(loadFixture("night-shift").tracks).toHaveLength(6);
    expect(loadFixture("paper-lanterns").tracks).toHaveLength(3);
    expect(loadFixture("hostile-names").tracks).toHaveLength(3);
  });

  it("has unique cases with valid regions and a moment UI context", () => {
    const cases = loadCases();
    expect(cases.length).toBeGreaterThanOrEqual(40);
    expect(new Set(cases.map((benchCase) => benchCase.id)).size).toBe(cases.length);
    for (const benchCase of cases) {
      expect(benchCase.prompt.length).toBeGreaterThan(0);
      if (benchCase.region !== undefined) {
        expect(benchCase.uiContext.view).toBe("moment");
        expect(benchCase.region.startTick).toBeLessThan(benchCase.region.endTick);
      }
    }
  });

  it("covers the 10 §8 policy prompts from the shared fixture", () => {
    const policy: unknown = JSON.parse(
      readFileSync(join(BENCH_DIR, "policy-prompts.json"), "utf8"),
    );
    if (!isRecord(policy) || !Array.isArray(policy.withNames)) throw new Error("bad fixture");
    const prompts = new Set(
      policy.withNames
        .filter(isRecord)
        .map((entry) => (typeof entry.prompt === "string" ? entry.prompt : "")),
    );
    const benchPolicy = loadCases().filter((benchCase) => benchCase.id.startsWith("policy-"));
    expect(benchPolicy).toHaveLength(5);
    for (const benchCase of benchPolicy) expect(prompts.has(benchCase.prompt)).toBe(true);
  });

  it("selects cases by exact id and glob", () => {
    const cases = loadCases();
    expect(selectCases(cases, "fx-warm-drums").map((entry) => entry.id)).toEqual(["fx-warm-drums"]);
    expect(selectCases(cases, "fx-*").every((entry) => entry.id.startsWith("fx-"))).toBe(true);
    expect(selectCases(cases, "mix-mute-texture,policy-jackson").map((entry) => entry.id)).toEqual([
      "mix-mute-texture",
      "policy-jackson",
    ]);
  });
});

describe("bench options", () => {
  it("parses the documented flags", () => {
    expect(
      parseArgs([
        "--model",
        "vendor/model",
        "--cases=fx-*",
        "--concurrency",
        "2",
        "--repeat",
        "3",
        "--record",
      ]),
    ).toEqual({
      model: "vendor/model",
      cases: "fx-*",
      concurrency: 2,
      repeat: 3,
      record: true,
    });
  });

  it("rejects dry and record together and an unknown tier", () => {
    expect(() => parseArgs(["--dry", "--record"])).toThrow(/one or the other/);
    expect(() => parseArgs(["--tier", "smartish"])).toThrow(/--tier must be fast or smart/);
  });
});

describe("bench metrics", () => {
  it("computes the rates, percentiles and over-reach count", () => {
    const base = {
      fixture: "paper-lanterns",
      prompt: "p",
      tier: "fast" as const,
      model: "m",
      expectationPass: true,
      checks: [],
      calls: [{ latencyMs: 10, model: "m" }],
      dropped: [],
      repaired: false,
      overReach: false,
      clarification: false,
    };
    const metrics = computeMetrics([
      { ...base, id: "a", valid: true, latencyMs: 100 },
      { ...base, id: "b", valid: true, latencyMs: 200 },
      { ...base, id: "c", valid: false, expectationPass: false, latencyMs: 300, overReach: true },
    ]);
    expect(metrics.runs).toBe(3);
    expect(metrics.valid).toBe(2);
    expect(metrics.validRate).toBeCloseTo(2 / 3);
    expect(metrics.expectationPass).toBe(2);
    expect(metrics.p50LatencyMs).toBe(200);
    expect(metrics.p95LatencyMs).toBe(300);
    expect(metrics.overReach).toBe(1);
  });
});

describe("offline dry run", () => {
  it("replays three recorded cases without a key or network", async () => {
    const summary = await runBench({
      dry: true,
      cases: SMOKE_CASES.join(","),
      concurrency: 1,
      write: false,
      quiet: true,
    });
    expect(summary.runs).toHaveLength(SMOKE_CASES.length);
    expect(summary.skipped).toEqual([]);
    expect(summary.metrics.overReach).toBe(0);
    expect(summary.metrics.validRate).toBe(1);
    expect(summary.metrics.expectationPassRate).toBe(1);
  });
});

/** A plain object, not an array or null. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
