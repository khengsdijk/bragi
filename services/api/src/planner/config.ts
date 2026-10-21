/**
 * Planner configuration: `config/planner.toml` plus environment overrides (06 §4).
 *
 * The model IDs are OpenRouter slugs and live in config, not in code, so the owner can trade
 * quality against cost without a release. `smol-toml` parses the file; the parsed shape is
 * validated here, because TOML knows nothing about planner tiers or limits (docs/wp/2.6.md §B).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parse } from "smol-toml";

/** The three model tiers (06 §4). */
export type PlannerTier = "fast" | "smart" | "explain";

/**
 * How much a tier's model may reason before it answers (OpenRouter's unified `reasoning`
 * parameter). `off` disables it, `default` leaves the model's own default, and the efforts map
 * to `reasoning.effort`. Reasoning tokens dominate planner latency (WP-2.6 bench).
 */
export type ReasoningLevel = "default" | "off" | "low" | "medium" | "high";

const REASONING_LEVELS: readonly ReasoningLevel[] = ["default", "off", "low", "medium", "high"];

/** The planner's effective configuration. */
export interface PlannerConfig {
  models: Record<PlannerTier, string>;
  reasoning: Record<PlannerTier, ReasoningLevel>;
  maxTokens: number;
  timeoutMs: number;
  /** Default number of variants when the request does not choose one (1–3). */
  variantCount: number;
}

/** The committed configuration file, resolved from this module in both `src/` and `dist/`. */
export const PLANNER_CONFIG_PATH = fileURLToPath(
  new URL("../../../../config/planner.toml", import.meta.url),
);

/** Environment variable per model tier. */
const MODEL_ENV: Record<PlannerTier, string> = {
  fast: "BRAGI_PLANNER_MODEL_FAST",
  smart: "BRAGI_PLANNER_MODEL_SMART",
  explain: "BRAGI_PLANNER_MODEL_EXPLAIN",
};

/** Overrides every tier's reasoning level (the bench uses it to compare settings). */
const REASONING_ENV = "BRAGI_PLANNER_REASONING";

/**
 * Reads and parses one TOML file.
 *
 * smol-toml's message carries the line, the column and a code frame; the path is prefixed so a
 * boot failure names the file it came from.
 *
 * @param path the file to read
 * @returns the parsed document, narrowed by the caller
 * @throws Error naming the file when it is unreadable or not valid TOML
 */
function parseDocument(path: string): unknown {
  const source = readFileSync(path, "utf8");
  try {
    return parse(source);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${path}: ${detail}`);
  }
}

/** True for a TOML table, which is what smol-toml nests every section as. */
function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A required `[section]` of the document. */
function requiredTable(
  document: Record<string, unknown>,
  name: string,
  path: string,
): Record<string, unknown> {
  const value = document[name];
  if (value === undefined) throw new Error(`${path}: missing [${name}] section`);
  if (!isTable(value)) throw new Error(`${path}: [${name}] must be a table`);
  return value;
}

/**
 * Reads the planner config and applies the environment overrides.
 *
 * @param env environment to read (defaults to `process.env`)
 * @param path config file path (tests pass a temp file)
 * @returns the validated configuration
 * @throws Error when the file is unreadable or a value is missing or invalid
 */
export function loadPlannerConfig(
  env: NodeJS.ProcessEnv = process.env,
  path: string = PLANNER_CONFIG_PATH,
): PlannerConfig {
  const parsed = parseDocument(path);
  if (!isTable(parsed)) throw new Error(`${path}: the document must be a TOML table`);
  const models = requiredTable(parsed, "models", path);
  const limits = requiredTable(parsed, "limits", path);

  const resolved = {} as Record<PlannerTier, string>;
  for (const tier of ["fast", "smart", "explain"] as const) {
    const value = env[MODEL_ENV[tier]] ?? models[tier];
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`${path}: models.${tier} must be a non-empty OpenRouter slug`);
    }
    resolved[tier] = value.trim();
  }

  const reasoningSection = parsed.reasoning;
  if (reasoningSection !== undefined && !isTable(reasoningSection)) {
    throw new Error(`${path}: [reasoning] must be a table`);
  }
  const reasoning = {} as Record<PlannerTier, ReasoningLevel>;
  for (const tier of ["fast", "smart", "explain"] as const) {
    const value =
      env[REASONING_ENV] ??
      (isTable(reasoningSection) ? reasoningSection[tier] : undefined) ??
      "default";
    if (!isReasoningLevel(value)) {
      throw new Error(`${path}: reasoning.${tier} must be one of ${REASONING_LEVELS.join(", ")}`);
    }
    reasoning[tier] = value;
  }

  return {
    models: resolved,
    reasoning,
    maxTokens: positiveInteger(limits.maxTokens, `${path}: limits.maxTokens`),
    timeoutMs: positiveInteger(limits.timeoutMs, `${path}: limits.timeoutMs`),
    variantCount: boundedVariantCount(limits.variantCount, `${path}: limits.variantCount`),
  };
}

/** True for one of the reasoning levels the planner understands. */
function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return typeof value === "string" && REASONING_LEVELS.some((level) => level === value);
}

/** A positive integer from the config, or a clear error. */
function positiveInteger(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${where} must be a positive integer`);
  }
  return value;
}

/** The default variant count: an integer 1–3 (06 §2). */
function boundedVariantCount(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 3) {
    throw new Error(`${where} must be 1, 2 or 3`);
  }
  return value;
}
