/**
 * Credit costs (specs/05-backend-and-jobs.md §9, specs/09-generation.md §2, §5).
 *
 * `config/credits.toml` is the table; this module turns one capability's params
 * into the credits a job costs and reads back what the user already spent today.
 * The formula is deliberately explicit, because the ledger is money-like:
 *
 *   extend  = n × ceil(bars × beats-per-bar × 60 / bpm / window_sec) × per30s
 *   inpaint = n × ceil(gapBars × beats-per-bar × 60 / bpm / window_sec) × per30s
 *   transition = n × per_candidate
 *
 * That is: every candidate pays the per-30-s rate for its own new audio, the
 * overlap the model re-creates for the splice is free, and a started window is
 * rounded up (15 bars at 120 BPM in 4/4 = 30 s = one window = 2 credits). Two-sided
 * capabilities pay for the gap only, not for the two rendered contexts. Preview
 * and HQ renders cost the same (09 §5); analysis jobs are free for now.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Pool } from "pg";
import { parse } from "smol-toml";
import { z } from "zod";

import type { Config } from "../config.js";

/**
 * What one capability costs (05 §9): per 30 s per candidate, once per job, or once
 * per candidate. `flat` is the text2music-style price ("10 per song"); a short bridge
 * is priced per candidate, because each candidate is its own generation (09 §2).
 */
export type CreditCost =
  | { readonly per30s: number }
  | { readonly flat: number }
  | { readonly perCandidate: number };

/** The validated credit table of `config/credits.toml`. */
export interface CreditsConfig {
  readonly windowSec: number;
  readonly capabilities: Readonly<Record<string, CreditCost>>;
  readonly multiUserDailyCredits: number;
}

/** The estimate the submit route returns and records. */
export interface CreditCharge {
  readonly credits: number;
  /** The leverage tier of the job, when the capability has one (`generate.extend`). */
  readonly tier?: string;
}

/**
 * The params field that holds the bars of requested audio, per capability.
 *
 * `generate.inpaint` is charged for its gap, not for the two contexts it is rendered
 * with, so its field is `gapBars` (09 §2, §4.3). Everything else that is priced per
 * 30 s asks for `bars`.
 */
export const DURATION_BARS_FIELD: Readonly<Record<string, string>> = {
  "generate.extend": "bars",
  "generate.inpaint": "gapBars",
};

const costSchema = z
  .object({
    per30s: z.number().positive().optional(),
    per_candidate: z.number().positive().optional(),
    flat: z.number().positive().optional(),
  })
  .refine(
    (cost) =>
      [cost.per30s, cost.per_candidate, cost.flat].filter((n) => n !== undefined).length === 1,
    {
      message: "a capability needs exactly one of per30s, per_candidate or flat",
    },
  );

const creditsSchema = z.object({
  window_sec: z.number().positive(),
  capabilities: z.record(z.string(), costSchema),
  daily: z.object({ multi_user_credits: z.number().int().nonnegative() }),
});

/** The repository root, from `dist/jobs/credits.js` or `src/jobs/credits.ts`. */
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/** Default location of the table, for the API's Docker image (repo root is `/app`). */
export const DEFAULT_CREDITS_PATH = join(REPO_ROOT, "config", "credits.toml");

/**
 * Parses and validates a TOML credits document.
 *
 * @throws Error naming the invalid key when the table is malformed
 */
export function parseCreditsConfig(document: unknown): CreditsConfig {
  const parsed = creditsSchema.safeParse(document);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`invalid credit table: ${detail}`);
  }
  const capabilities: Record<string, CreditCost> = {};
  for (const [name, cost] of Object.entries(parsed.data.capabilities)) {
    if (cost.per30s !== undefined) capabilities[name] = { per30s: cost.per30s };
    else if (cost.per_candidate !== undefined)
      capabilities[name] = { perCandidate: cost.per_candidate };
    else if (cost.flat !== undefined) capabilities[name] = { flat: cost.flat };
  }
  return {
    windowSec: parsed.data.window_sec,
    capabilities,
    multiUserDailyCredits: parsed.data.daily.multi_user_credits,
  };
}

const cache = new Map<string, CreditsConfig>();

/**
 * Loads `config/credits.toml` once per path.
 *
 * @param path the table (`BRAGI_CREDITS_CONFIG`), or the repository default
 * @throws Error when the file is missing or invalid; a bad table must fail boot,
 *   not silently charge 0
 */
export function creditsConfig(path?: string): CreditsConfig {
  const source = path === undefined || path === "" ? DEFAULT_CREDITS_PATH : path;
  const cached = cache.get(source);
  if (cached !== undefined) return cached;
  const parsed = parseCreditsConfig(parse(readFileSync(source, "utf8")));
  cache.set(source, parsed);
  return parsed;
}

/** The facts a per-30-s capability needs to price a job (09 §2). */
interface TimedParams {
  /** Bars of requested new audio: `bars` for an extend, `gapBars` for an inpaint. */
  readonly durationBars: number;
  readonly n: number;
  readonly bpm: number;
  readonly beatsPerBar: number;
}

/** The pricing facts of one job, or `undefined` when the params do not carry them. */
function timedParams(value: Record<string, unknown>, barsField: string): TimedParams | undefined {
  const context = value.context;
  if (typeof context !== "object" || context === null) return undefined;
  const facts = context as Record<string, unknown>;
  const signature = facts.timeSignature;
  const bars = value[barsField];
  const n = value.n;
  if (
    typeof bars !== "number" ||
    typeof n !== "number" ||
    typeof facts.bpm !== "number" ||
    !Array.isArray(signature) ||
    typeof signature[0] !== "number" ||
    signature[0] <= 0
  ) {
    return undefined;
  }
  return { durationBars: bars, n, bpm: facts.bpm, beatsPerBar: signature[0] };
}

/** The candidate count of a job, `1` when the params do not say (validation runs first). */
function candidateCount(params: Record<string, unknown>): number {
  const n = params.n;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 1;
}

/** The leverage tier a job records in the ledger, when its capability has one. */
function tierOf(params: Record<string, unknown>): Pick<CreditCharge, "tier"> {
  return typeof params.tier === "string" ? { tier: params.tier } : {};
}

/** Seconds of new audio an extend asks for, excluding the overlap (09 §4.2). */
export function extendDurationSec(bars: number, bpm: number, beatsPerBar: number): number {
  return (bars * beatsPerBar * 60) / bpm;
}

/**
 * Started windows of `windowSec`, rounded up.
 *
 * The epsilon keeps an exact multiple (a 30.0 s extend) on one window: floating
 * point makes `30 / 30` occasionally `1.0000000000000002`.
 */
export function creditWindows(durationSec: number, windowSec: number): number {
  return Math.max(1, Math.ceil(durationSec / windowSec - 1e-9));
}

/**
 * The credits one submit costs.
 *
 * @param capability the job's capability
 * @param params its validated params
 * @param config the credit table
 * @returns the charge; capabilities absent from the table are free
 */
export function creditCharge(
  capability: string,
  params: Record<string, unknown>,
  config: CreditsConfig,
): CreditCharge {
  const cost = config.capabilities[capability];
  if (cost === undefined) return { credits: 0 };
  if ("flat" in cost) return { credits: cost.flat, ...tierOf(params) };
  if ("perCandidate" in cost) {
    return { credits: cost.perCandidate * candidateCount(params), ...tierOf(params) };
  }
  const barsField = DURATION_BARS_FIELD[capability] ?? "bars";
  const timed = timedParams(params, barsField);
  if (timed === undefined) return { credits: 0 };
  const duration = extendDurationSec(timed.durationBars, timed.bpm, timed.beatsPerBar);
  const windows = creditWindows(duration, config.windowSec);
  return {
    credits: windows * cost.per30s * timed.n,
    ...tierOf(params),
  };
}

/**
 * The user's daily allowance, or `undefined` for unlimited.
 *
 * Single-user mode is unlimited unless `BRAGI_DAILY_CREDITS` says otherwise, but
 * every job is still recorded (05 §9). Multi-user falls back to the table's
 * `[daily].multi_user_credits` when the variable is unset.
 */
export function dailyCreditAllowance(
  config: Config,
  credits: CreditsConfig = creditsConfig(config.creditsConfig),
): number | undefined {
  if (config.dailyCredits !== undefined) return config.dailyCredits;
  return config.authMode === "single-user" ? undefined : credits.multiUserDailyCredits;
}

/** Credits this user spent since the start of the UTC day. */
export async function creditsUsedToday(
  pool: Pool,
  userId: string,
  now = new Date(),
): Promise<number> {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const { rows } = await pool.query<{ used: number }>(
    "SELECT COALESCE(SUM(credits), 0)::float8 AS used FROM usage_ledger WHERE user_id = $1 AND created_at >= $2",
    [userId, start],
  );
  return rows[0]?.used ?? 0;
}

/** True when `charge` still fits in the allowance (`undefined` = unlimited). */
export function fitsAllowance(
  used: number,
  allowance: number | undefined,
  charge: number,
): boolean {
  return allowance === undefined || used + charge <= allowance;
}
