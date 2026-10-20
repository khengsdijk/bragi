/**
 * Planner configuration: `config/planner.toml` plus environment overrides (06 §4).
 *
 * The model IDs are OpenRouter slugs and live in config, not in code, so the owner can trade
 * quality against cost without a release. The TOML subset is deliberately tiny (`[section]`,
 * `key = value` with strings, integers, floats and booleans); the repo has no TOML parser in
 * the API's dependency tree and a new dependency is out of scope (docs/wp/2.6.md §B).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The three model tiers (06 §4). */
export type PlannerTier = "fast" | "smart" | "explain";

/** A value the tiny parser understands. */
export type TomlScalar = string | number | boolean;

/** A TOML document: top-level scalars and one nested record per `[section]`. */
export type TomlDocument = Record<string, TomlScalar | Record<string, TomlScalar>>;

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
 * Parses the flat TOML subset planner config uses.
 *
 * Comments (`#` outside a string), blank lines, `[section]` headers and `key = value` lines are
 * supported. Values are double-quoted strings, integers, floats or `true`/`false`; anything else
 * (arrays, inline tables, dates) is rejected with a line number instead of being guessed at.
 *
 * @param text the file contents
 * @returns top-level scalars and one record per section
 * @throws Error naming the line when the input is outside the subset
 */
export function parseToml(text: string): TomlDocument {
  const document: TomlDocument = {};
  let section: Record<string, TomlScalar> | null = null;

  text.split(/\r?\n/).forEach((rawLine, index) => {
    const line = stripComment(rawLine).trim();
    if (line === "") return;
    const where = `line ${index + 1}`;

    if (line.startsWith("[")) {
      const match = /^\[([A-Za-z0-9_-]+)\]$/.exec(line);
      if (match?.[1] === undefined) throw new Error(`${where}: malformed [section] header`);
      const name = match[1];
      if (Object.hasOwn(document, name)) throw new Error(`${where}: duplicate section [${name}]`);
      section = {};
      document[name] = section;
      return;
    }

    const equals = line.indexOf("=");
    if (equals <= 0) throw new Error(`${where}: expected "key = value"`);
    const key = line.slice(0, equals).trim();
    if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new Error(`${where}: invalid key "${key}"`);
    const value = parseScalar(line.slice(equals + 1).trim(), where);
    const target = section ?? document;
    if (Object.hasOwn(target, key)) throw new Error(`${where}: duplicate key "${key}"`);
    target[key] = value;
  });

  return document;
}

/** Removes a `#` comment that is not inside a double-quoted string. */
function stripComment(line: string): string {
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"' && line[i - 1] !== "\\") quoted = !quoted;
    if (char === "#" && !quoted) return line.slice(0, i);
  }
  return line;
}

/** Parses one supported TOML scalar. */
function parseScalar(raw: string, where: string): TomlScalar {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) throw new Error(`${where}: unterminated string`);
    return raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?[0-9]+$/.test(raw)) return Number.parseInt(raw, 10);
  if (/^-?[0-9]+\.[0-9]+$/.test(raw)) return Number.parseFloat(raw);
  throw new Error(`${where}: unsupported value "${raw}"`);
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
  const document = parseToml(readFileSync(path, "utf8"));
  const models = document.models;
  const limits = document.limits;
  if (models === undefined || typeof models !== "object") {
    throw new Error(`${path}: missing [models] section`);
  }
  if (limits === undefined || typeof limits !== "object") {
    throw new Error(`${path}: missing [limits] section`);
  }

  const resolved = {} as Record<PlannerTier, string>;
  for (const tier of ["fast", "smart", "explain"] as const) {
    const value = env[MODEL_ENV[tier]] ?? models[tier];
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`${path}: models.${tier} must be a non-empty OpenRouter slug`);
    }
    resolved[tier] = value.trim();
  }

  const reasoningSection = document.reasoning;
  const reasoning = {} as Record<PlannerTier, ReasoningLevel>;
  for (const tier of ["fast", "smart", "explain"] as const) {
    const value =
      env[REASONING_ENV] ??
      (typeof reasoningSection === "object" ? reasoningSection[tier] : undefined) ??
      "default";
    if (typeof value !== "string" || !REASONING_LEVELS.includes(value as ReasoningLevel)) {
      throw new Error(`${path}: reasoning.${tier} must be one of ${REASONING_LEVELS.join(", ")}`);
    }
    reasoning[tier] = value as ReasoningLevel;
  }

  return {
    models: resolved,
    reasoning,
    maxTokens: positiveInteger(limits.maxTokens, `${path}: limits.maxTokens`),
    timeoutMs: positiveInteger(limits.timeoutMs, `${path}: limits.timeoutMs`),
    variantCount: boundedVariantCount(limits.variantCount, `${path}: limits.variantCount`),
  };
}

/** A positive integer from the config, or a clear error. */
function positiveInteger(value: TomlScalar | undefined, where: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${where} must be a positive integer`);
  }
  return value;
}

/** The default variant count: an integer 1–3 (06 §2). */
function boundedVariantCount(value: TomlScalar | undefined, where: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 3) {
    throw new Error(`${where} must be 1, 2 or 3`);
  }
  return value;
}
