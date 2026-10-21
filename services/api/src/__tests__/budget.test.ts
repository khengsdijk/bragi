import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../config.js";
import { budgetExceeded, gpuSecondsToday, isGpuCapability } from "../jobs/budget.js";

function pool(seconds: number): Pool {
  const fake = {
    query: async (sql: string, params: unknown[]) => {
      expect(sql).toContain("SUM(gpu_seconds)");
      expect(params).toHaveLength(1);
      return { rows: [{ seconds }], rowCount: 1 };
    },
  };
  return fake as unknown as Pool;
}

describe("the GPU budget guard (05 §9)", () => {
  it("guards generation capabilities only", () => {
    expect(isGpuCapability("generate.extend")).toBe(true);
    expect(isGpuCapability("transform.style")).toBe(true);
    expect(isGpuCapability("analysis.separation")).toBe(false);
    expect(isGpuCapability("embed.project")).toBe(false);
  });

  it("sums today's completed GPU seconds from UTC midnight", async () => {
    const queries: unknown[] = [];
    const fake = {
      query: async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        return { rows: [{ seconds: 12.5 }], rowCount: 1 };
      },
    };
    const now = new Date("2026-10-21T09:00:00.000Z");
    await expect(gpuSecondsToday(fake as unknown as Pool, now)).resolves.toBe(12.5);
    expect(queries[0]).toMatchObject({ params: [new Date("2026-10-21T00:00:00.000Z")] });
  });

  it("has no cap when BRAGI_GPU_SECONDS_PER_DAY is unset", async () => {
    const config = loadConfig({});
    await expect(budgetExceeded(pool(1_000), config)).resolves.toBe(false);
  });

  it("is exceeded at the cap and above", async () => {
    const config = loadConfig({ BRAGI_GPU_SECONDS_PER_DAY: "100" });
    await expect(budgetExceeded(pool(99.9), config)).resolves.toBe(false);
    await expect(budgetExceeded(pool(100), config)).resolves.toBe(true);
    await expect(budgetExceeded(pool(120), config)).resolves.toBe(true);
  });
});
