import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../config.js";
import {
  creditCharge,
  creditsConfig,
  creditsUsedToday,
  creditWindows,
  dailyCreditAllowance,
  extendDurationSec,
  fitsAllowance,
  parseCreditsConfig,
} from "../jobs/credits.js";

const EXTEND = {
  context: {
    bpm: 120,
    timeSignature: [4, 4],
    key: { tonic: "A", mode: "minor" },
    descriptors: ["warm analog synths"],
    seed: 1234,
  },
  bars: 15,
  overlapBars: 2,
  direction: "forward",
  tier: "preview",
  n: 3,
};

describe("config/credits.toml", () => {
  it("carries the 09 §2 rates", () => {
    const config = creditsConfig();
    expect(config.windowSec).toBe(30);
    expect(config.capabilities["generate.extend"]).toEqual({ per30s: 2 });
    expect(config.capabilities["generate.text2music"]).toEqual({ flat: 10 });
    expect(config.multiUserDailyCredits).toBeGreaterThan(0);
  });

  it("rejects a malformed table instead of charging 0", () => {
    expect(() => parseCreditsConfig({ window_sec: 30 })).toThrow(/daily/);
    expect(() =>
      parseCreditsConfig({
        window_sec: 30,
        capabilities: { "generate.extend": { per30s: 2, flat: 1 } },
        daily: { multi_user_credits: 50 },
      }),
    ).toThrow(/exactly one of per30s or flat/);
  });
});

describe("the extend credit formula", () => {
  it("prices new audio only: 15 bars at 120 BPM in 4/4 is one 30 s window", () => {
    expect(extendDurationSec(15, 120, 4)).toBe(30);
    expect(creditWindows(30, 30)).toBe(1);
    expect(creditWindows(30.000_001, 30)).toBe(2);
    expect(creditWindows(0.5, 30)).toBe(1);
  });

  it("charges the rate per candidate", () => {
    const config = creditsConfig();
    expect(creditCharge("generate.extend", EXTEND, config)).toEqual({
      credits: 6,
      tier: "preview",
    });
    expect(creditCharge("generate.extend", { ...EXTEND, n: 1 }, config).credits).toBe(2);
  });

  it("charges HQ once at the same rate", () => {
    const config = creditsConfig();
    const hq = { ...EXTEND, n: 1, tier: "hq", seed: 1235 };
    expect(creditCharge("generate.extend", hq, config)).toEqual({ credits: 2, tier: "hq" });
  });

  it("rounds a started window up", () => {
    const config = creditsConfig();
    // 16 bars at 120 BPM in 4/4 is 32 s, so two windows.
    expect(creditCharge("generate.extend", { ...EXTEND, bars: 16, n: 1 }, config).credits).toBe(4);
    expect(creditCharge("generate.extend", { ...EXTEND, bars: 1, n: 1 }, config).credits).toBe(2);
  });

  it("reads a flat capability once per job and leaves unknown ones free", () => {
    const config = creditsConfig();
    const flat = { ...EXTEND, bars: 64, n: 4 };
    expect(creditCharge("generate.text2music", flat, config).credits).toBe(10);
    expect(creditCharge("analysis.separation", flat, config).credits).toBe(0);
  });

  it("does not outrageously price malformed params (they never reach here)", () => {
    const config = creditsConfig();
    expect(creditCharge("generate.extend", {}, config).credits).toBe(0);
  });
});

describe("the daily allowance", () => {
  it("is unlimited in single-user mode unless BRAGI_DAILY_CREDITS says otherwise", () => {
    const credits = creditsConfig();
    const single = loadConfig({ BRAGI_AUTH_MODE: "single-user" });
    expect(dailyCreditAllowance(single, credits)).toBeUndefined();

    const limited = loadConfig({ BRAGI_AUTH_MODE: "single-user", BRAGI_DAILY_CREDITS: "20" });
    expect(dailyCreditAllowance(limited, credits)).toBe(20);
  });

  it("falls back to the table in multi-user mode", () => {
    const credits = creditsConfig();
    const multi = loadConfig({ BRAGI_AUTH_MODE: "multi-user" });
    expect(dailyCreditAllowance(multi, credits)).toBe(credits.multiUserDailyCredits);
  });

  it("fits a charge against the remaining allowance", () => {
    expect(fitsAllowance(0, undefined, 1000)).toBe(true);
    expect(fitsAllowance(4, 6, 2)).toBe(true);
    expect(fitsAllowance(5, 6, 2)).toBe(false);
  });

  it("sums today's ledger rows for the user", async () => {
    const queries: unknown[] = [];
    const pool = {
      query: async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        return { rows: [{ used: 4 }], rowCount: 1 };
      },
    };
    const now = new Date("2026-10-21T23:30:00.000Z");
    await expect(creditsUsedToday(pool as unknown as Pool, "usr_1", now)).resolves.toBe(4);
    expect(queries[0]).toMatchObject({
      params: ["usr_1", new Date("2026-10-21T00:00:00.000Z")],
    });
  });
});
