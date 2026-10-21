/**
 * The planner bench (06 §9, docs/wp/2.6.md task C).
 *
 * Runs the real planner over fixture projects and structural expectations, or replays previously
 * recorded replies with `--dry` for an offline smoke test. The output is a table per case plus the
 * four 06 §9 metrics: valid plan rate, expectation pass rate, P50/P95 latency and over-reach. The
 * JSON report lands in `bench-results/` (git-ignored) for the review record.
 *
 * Nothing here prints, logs or records the API key: recordings hold replies only (text, tool
 * arguments and optional usage), never request headers or the environment.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

import type { EditPlan, PlanRequest, Project, Region } from "@bragi/schemas";
import { validateProject } from "@bragi/schemas";

import { ApiError } from "../../src/errors.js";
import { classify, hasSongWideIntent } from "../../src/planner/classify.js";
import {
  loadPlannerConfig,
  type PlannerConfig,
  type PlannerTier,
} from "../../src/planner/config.js";
import { createWasmSummarizer } from "../../src/planner/context.js";
import { normalizePlanEnvelope } from "../../src/planner/json.js";
import {
  type LlmReply,
  type LlmUsage,
  OpenRouterClient,
  type PlannerLlm,
  PlannerUnavailableError,
} from "../../src/planner/openrouter.js";
import { Planner } from "../../src/planner/planner.js";
import { applyPolicy } from "../../src/planner/policy.js";
import {
  type DryRunModel,
  diffDocuments,
  dryRunVariant,
  regionInsideSong,
  validateRawPlan,
} from "../../src/planner/validate.js";
import { loadModelWasm } from "../../src/planner/wasm.js";
import {
  type CheckResult,
  type Expectations,
  evaluateExpectations,
  overReaches,
  reachesOutsideRegion,
} from "./expectations.js";

/** The repository root, resolved from this file in source and in a copied build. */
export const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
/** The bench directory. */
export const BENCH_DIR = join(ROOT, "services", "api", "test", "planner-bench");
/** Where `--record` stores replies for `--dry`; committed so the smoke test is offline. */
export const RECORDINGS_PATH = join(BENCH_DIR, "recordings", "replies.json");
/** Where the runner writes its JSON report (git-ignored). */
export const RESULTS_DIR = join(ROOT, "bench-results");

/** One bench case from `cases.json`. */
export interface BenchCase {
  id: string;
  fixture: string;
  prompt: string;
  region?: Region;
  uiContext: PlanRequest["uiContext"];
  expectations: Expectations;
}

/** What one model call cost and produced. */
interface CallRecord {
  latencyMs: number;
  model: string;
  usage?: LlmUsage;
  reply: LlmReply;
}

/** One case execution. */
export interface CaseRun {
  id: string;
  fixture: string;
  prompt: string;
  tier: PlannerTier;
  model: string;
  valid: boolean;
  error?: string;
  /** Why validation rejected the last reply, re-run offline for the report (invalid plans). */
  failureReasons?: string[];
  /** The last raw reply for an invalid run, kept in the report so a reviewer can see the model's shape. */
  rawReply?: string;
  expectationPass: boolean;
  checks: CheckResult[];
  calls: { latencyMs: number; model: string; usage?: LlmUsage }[];
  latencyMs: number;
  dropped: string[];
  repaired: boolean;
  overReach: boolean;
  overReachDetail?: string;
  clarification: boolean;
  plan?: EditPlan;
}

/** The 06 §9 metrics over one bench run. */
export interface BenchMetrics {
  runs: number;
  valid: number;
  validRate: number;
  expectationPass: number;
  expectationPassRate: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  overReach: number;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd?: number;
}

/** Everything a run reports. */
export interface BenchSummary {
  model: string;
  dry: boolean;
  startedAt: string;
  finishedAt: string;
  runs: CaseRun[];
  skipped: { id: string; reason: string }[];
  metrics: BenchMetrics;
  resultsPath?: string;
}

/** Runner options; the CLI fills them from argv. */
export interface BenchOptions {
  dry?: boolean;
  record?: boolean;
  model?: string;
  tier?: PlannerTier;
  cases?: string;
  concurrency?: number;
  repeat?: number;
  /** Write the JSON report (the offline test turns this off). */
  write?: boolean;
  /** Suppress the table (tests assert structurally instead). */
  quiet?: boolean;
  env?: NodeJS.ProcessEnv;
}

/** A recorded reply, with no headers or key material. */
interface RecordedReply {
  text: string;
  toolArguments?: string;
  usage?: LlmUsage;
}

/** The recordings file. */
interface Recordings {
  version: 1;
  model: string;
  recordedAt: string;
  cases: Record<string, { replies: RecordedReply[] }>;
}

/** The planner dependencies one case needs. */
interface BenchDeps {
  planner: Planner;
  model: DryRunModel;
  config: PlannerConfig;
}

/** A reply source for one case: live, recorded and replayed, or recording as it goes. */
interface CaseClient {
  client: PlannerLlm;
  calls: CallRecord[];
}

/**
 * Fills an env object from the local env files exactly like `scripts/dev-backend.mjs`:
 * root `.env`, then `infra/.env`; a value already set wins and an empty value is skipped.
 *
 * @param env the target environment (defaults to `process.env`)
 * @param root the repository root (tests pass a temp directory)
 */
export function loadLocalEnv(env: NodeJS.ProcessEnv = process.env, root = ROOT): void {
  for (const file of [join(root, ".env"), join(root, "infra", ".env")]) {
    if (!existsSync(file)) continue;
    for (const [name, value] of Object.entries(parseEnv(readFileSync(file, "utf8")))) {
      if (value !== "" && env[name] === undefined) env[name] = value;
    }
  }
}

/** Parses the command line; values may be `--flag value` or `--flag=value`. */
export function parseArgs(argv: readonly string[]): BenchOptions {
  const options: BenchOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    const [flag, inline] = splitFlag(argument);
    const takeValue = (): string => {
      if (inline !== undefined) return inline;
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${flag} needs a value`);
      }
      index += 1;
      return value;
    };
    switch (flag) {
      case "--dry":
        options.dry = true;
        break;
      case "--record":
        options.record = true;
        break;
      case "--model":
        options.model = takeValue();
        break;
      case "--tier": {
        const value = takeValue();
        if (value !== "fast" && value !== "smart") {
          throw new Error("--tier must be fast or smart");
        }
        options.tier = value;
        break;
      }
      case "--cases":
        options.cases = takeValue();
        break;
      case "--concurrency":
        options.concurrency = boundedInteger(takeValue(), "--concurrency", 1, 32);
        break;
      case "--repeat":
        options.repeat = boundedInteger(takeValue(), "--repeat", 1, 10);
        break;
      case "--help":
      case "-h":
        throw new HelpRequested();
      default:
        throw new Error(`unknown option ${flag}`);
    }
  }
  if (options.dry === true && options.record === true) {
    throw new Error("--dry replays recordings and --record writes them; pass one or the other");
  }
  return options;
}

/** A `--flag=value` pair, or the flag alone. */
function splitFlag(argument: string): [string, string | undefined] {
  const equals = argument.indexOf("=");
  return equals === -1
    ? [argument, undefined]
    : [argument.slice(0, equals), argument.slice(equals + 1)];
}

/** A bounded integer option. */
function boundedInteger(raw: string, flag: string, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${flag} must be an integer ${min}–${max}`);
  }
  return value;
}

/** Thrown for `--help`; `main` prints usage and exits 0. */
export class HelpRequested extends Error {}

/** The usage text. */
export function usage(): string {
  return [
    "Usage: pnpm bench:planner [options]",
    "",
    "  --model <slug>       override every tier (OpenRouter slug)",
    "  --tier fast|smart    run only cases the classifier puts in that tier",
    "  --cases <ids|glob>   comma-separated case IDs or globs (e.g. fx-*,mix-*)",
    "  --concurrency <n>    parallel cases, 1–32 (default 4)",
    "  --repeat <n>         run every selected case n times, 1–10 (default 1)",
    "  --dry                replay recordings/replies.json (offline; no API key)",
    "  --record             record replies for --dry (live run; costs API credits)",
    "  --help               this text",
  ].join("\n");
}

/**
 * Runs the bench.
 *
 * @param argv CLI arguments (without `node` and the script)
 * @returns the summary that was printed and written
 */
export async function main(argv: readonly string[]): Promise<BenchSummary> {
  const options = parseArgs(argv);
  loadLocalEnv(options.env ?? process.env);
  const summary = await runBench(options);
  return summary;
}

/**
 * Runs the selected cases and reports the 06 §9 metrics.
 *
 * @param options runner options
 * @returns the summary, including the path of the written report (unless `write` is false)
 */
export async function runBench(options: BenchOptions = {}): Promise<BenchSummary> {
  const env = options.env ?? process.env;
  const concurrency = options.concurrency ?? 4;
  const repeat = options.repeat ?? 1;
  const startedAt = new Date().toISOString();
  const allCases = loadCases();
  const selected = selectCases(allCases, options.cases);
  if (selected.length === 0) throw new Error(`no cases match "${options.cases ?? ""}"`);

  const config = benchConfig(env, options.model);
  const recordings = options.dry === true ? loadRecordings() : undefined;
  const wasm = await loadModelWasm();
  const summarizer = createWasmSummarizer();
  const liveClient =
    options.dry === true ? undefined : OpenRouterClient.fromEnv(env, config.timeoutMs);

  const jobs: { benchCase: BenchCase; iteration: number }[] = [];
  for (let iteration = 0; iteration < repeat; iteration += 1) {
    for (const benchCase of selected) jobs.push({ benchCase, iteration });
  }

  const skipped: { id: string; reason: string }[] = [];
  const recorded = new Map<string, RecordedReply[]>();
  const runnable = jobs.filter(({ benchCase }) => {
    if (options.dry !== true) return true;
    const entry = recordings?.cases[benchCase.id];
    if (entry !== undefined && entry.replies.length > 0) return true;
    if (!skipped.some((skip) => skip.id === benchCase.id)) {
      skipped.push({ id: benchCase.id, reason: "no recording" });
    }
    return false;
  });

  const results = await mapConcurrent(runnable, concurrency, async ({ benchCase, iteration }) => {
    const request = requestOf(benchCase);
    const classification = classify(request);
    if (options.tier !== undefined && classification.tier !== options.tier) return undefined;

    const caseClient =
      options.dry === true
        ? replayClient(recordings?.cases[benchCase.id]?.replies ?? [])
        : liveCaseClient(liveClient);
    const deps: BenchDeps = {
      planner: new Planner({ client: caseClient.client, summarizer, model: wasm, config }),
      model: wasm,
      config,
    };
    const run = await runCase(benchCase, request, deps, caseClient);
    if (options.record === true) recorded.set(benchCase.id, caseClient.calls.map(recordingOf));
    if (repeat > 1) run.id = `${benchCase.id}#${iteration + 1}`;
    return run;
  });

  const runs = results.filter((run): run is CaseRun => run !== undefined);
  const metrics = computeMetrics(runs);

  // Over-reach is the one metric that must be zero by construction (06 §7, §9): a returned variant
  // that validation let through but that reaches outside its region is a validator bug, not a
  // quality datapoint.
  if (metrics.overReach > 0) {
    for (const run of runs.filter((candidate) => candidate.overReach)) {
      console.error(`over-reach in ${run.id}: ${run.overReachDetail ?? "outside the region"}`);
    }
  }

  if (options.record === true) {
    saveRecordings(
      recorded,
      config.models.fast,
      startedAt,
      allCases.map((benchCase) => benchCase.id),
    );
  }

  const summary: BenchSummary = {
    model: config.models.fast,
    dry: options.dry === true,
    startedAt,
    finishedAt: new Date().toISOString(),
    runs,
    skipped,
    metrics,
  };
  if (options.write !== false) summary.resultsPath = writeResults(summary);
  if (options.quiet !== true) printSummary(summary);
  return summary;
}

/** Builds the config, applying `--model` to every tier (never changing the file). */
function benchConfig(env: NodeJS.ProcessEnv, model: string | undefined): PlannerConfig {
  const config = loadPlannerConfig(env);
  if (model === undefined) return config;
  return { ...config, models: { fast: model, smart: model, explain: model } };
}

/** Wraps the live client and records every call's latency and reply. */
function liveCaseClient(client: PlannerLlm | undefined): CaseClient {
  if (client === undefined) throw new PlannerUnavailableError("the live client is missing");
  const calls: CallRecord[] = [];
  return {
    calls,
    client: {
      async complete(request) {
        const started = performance.now();
        const reply = await client.complete(request);
        calls.push({ latencyMs: performance.now() - started, model: request.model, reply });
        return reply;
      },
    },
  };
}

/** Replays the replies recorded for one case; latency is measured but is the replay's. */
function replayClient(replies: readonly RecordedReply[]): CaseClient {
  const calls: CallRecord[] = [];
  let index = 0;
  return {
    calls,
    client: {
      async complete(request) {
        const started = performance.now();
        const recorded = replies[index];
        index += 1;
        if (recorded === undefined) {
          throw new Error(
            `the recording has ${replies.length} repl${replies.length === 1 ? "y" : "ies"} but the planner asked for call ${index}; re-record with --record`,
          );
        }
        const reply: LlmReply = {
          text: recorded.text,
          ...(recorded.toolArguments === undefined
            ? {}
            : { toolArguments: recorded.toolArguments }),
          ...(recorded.usage === undefined ? {} : { usage: recorded.usage }),
        };
        calls.push({ latencyMs: performance.now() - started, model: request.model, reply });
        return reply;
      },
    },
  };
}

/** Strips a call down to the committed recording shape (no headers, no key). */
function recordingOf(call: CallRecord): RecordedReply {
  return {
    text: call.reply.text,
    ...(call.reply.toolArguments === undefined ? {} : { toolArguments: call.reply.toolArguments }),
    ...(call.reply.usage === undefined ? {} : { usage: call.reply.usage }),
  };
}

/** Builds the request the route would send. */
export function requestOf(benchCase: BenchCase): PlanRequest {
  return {
    doc: loadFixture(benchCase.fixture),
    prompt: benchCase.prompt,
    uiContext: benchCase.uiContext,
    ...(benchCase.region === undefined ? {} : { region: benchCase.region }),
  };
}

/** Runs one case and evaluates its expectations. */
async function runCase(
  benchCase: BenchCase,
  request: PlanRequest,
  deps: BenchDeps,
  caseClient: CaseClient,
): Promise<CaseRun> {
  const started = performance.now();
  const tier = classify(request).tier;
  const model = deps.config.models[tier];
  let plan: EditPlan | undefined;
  let valid = false;
  let error: string | undefined;

  try {
    const result = await deps.planner.plan(request);
    if ("variants" in result) {
      plan = result;
      valid = true;
    } else {
      // The bench cases are ops-only plan prompts; an Explanation would be a classifier mistake.
      error = "the planner returned an Explanation";
    }
  } catch (failure) {
    if (failure instanceof ApiError) {
      error = `${failure.code}: ${failure.message}`;
    } else {
      error = failure instanceof Error ? failure.message : String(failure);
    }
  }
  const latencyMs = performance.now() - started;
  const calls = caseClient.calls;
  const dropped = plan === undefined ? [] : droppedLabels(calls, plan);
  const overReach = plan === undefined ? { count: 0 } : findOverReach(plan, request, deps.model);
  const failureReasons = plan === undefined ? await diagnose(calls, request, deps) : undefined;
  const rawReply = plan === undefined ? lastReply(calls) : undefined;

  const evaluation =
    plan === undefined
      ? undefined
      : evaluateExpectations({
          plan,
          doc: request.doc,
          expectations: benchCase.expectations,
          ...(request.region === undefined ? {} : { region: request.region }),
          dropped,
        });

  return {
    id: benchCase.id,
    fixture: benchCase.fixture,
    prompt: benchCase.prompt,
    tier,
    model,
    valid,
    ...(error === undefined ? {} : { error }),
    ...(failureReasons === undefined ? {} : { failureReasons }),
    ...(rawReply === undefined ? {} : { rawReply }),
    expectationPass: evaluation?.passed === true,
    checks: evaluation?.checks ?? expectationFailure(error),
    calls: calls.map((call) => ({
      latencyMs: round(call.latencyMs),
      model: call.model,
      ...(call.reply.usage === undefined ? {} : { usage: call.reply.usage }),
    })),
    latencyMs: round(latencyMs),
    dropped,
    repaired: calls.length > 1,
    overReach: overReach.count > 0,
    ...(overReach.detail === undefined ? {} : { overReachDetail: overReach.detail }),
    clarification: plan?.clarification !== undefined,
    ...(plan === undefined ? {} : { plan }),
  };
}

/** A failed run has no expectation checks of its own; record why it could not be evaluated. */
function expectationFailure(error: string | undefined): CheckResult[] {
  return [{ name: "valid", ok: false, detail: error ?? "no plan returned" }];
}

/**
 * Re-runs validation over the last reply to explain a `PLAN_INVALID`.
 *
 * The planner intentionally returns a plain message, not its internal reasons (06 §5); the bench
 * can afford the dry run and needs the reasons to tune the prompt. The replay is offline.
 */
async function diagnose(
  calls: readonly CallRecord[],
  request: PlanRequest,
  deps: BenchDeps,
): Promise<string[]> {
  const last = calls[calls.length - 1];
  if (last === undefined) return [];
  let raw: unknown;
  try {
    raw = normalizePlanEnvelope(JSON.parse(last.reply.toolArguments ?? last.reply.text));
  } catch {
    return ["the reply was not JSON"];
  }
  const policy = applyPolicy(request.prompt, request.libraryNames ?? []);
  const validation = await validateRawPlan(raw, {
    request,
    model: deps.model,
    songWideIntent: hasSongWideIntent(request.prompt),
    blockedNames: policy.names,
  });
  if (validation.ok) return ["validation passes on replay; the failure came from the model call"];
  return validation.errors.slice(0, 6);
}

/** The last raw reply for the report, capped so a runaway reasoning reply cannot bloat it. */
function lastReply(calls: readonly CallRecord[]): string | undefined {
  const last = calls[calls.length - 1];
  if (last === undefined) return undefined;
  const text = last.reply.toolArguments ?? last.reply.text;
  return text.length > 20_000 ? `${text.slice(0, 20_000)}…` : text;
}

/** Labels the validator dropped: variants in the last reply that are not in the returned plan. */
function droppedLabels(calls: readonly CallRecord[], plan: EditPlan): string[] {
  const last = calls[calls.length - 1];
  if (last === undefined) return [];
  let raw: unknown;
  try {
    raw = normalizePlanEnvelope(JSON.parse(last.reply.toolArguments ?? last.reply.text));
  } catch {
    return [];
  }
  if (!isRecord(raw) || !Array.isArray(raw.variants)) return [];
  const returned = new Set(plan.variants.map((variant) => variant.label));
  return raw.variants
    .map((variant) => (isRecord(variant) && typeof variant.label === "string" ? variant.label : ""))
    .filter((label) => label !== "" && !returned.has(label));
}

/** The authoritative over-reach check: dry-run each returned variant and diff the document. */
function findOverReach(
  plan: EditPlan,
  request: PlanRequest,
  model: DryRunModel,
): { count: number; detail?: string } {
  const reasons: string[] = [];
  plan.variants.forEach((variant, index) => {
    try {
      const { before, after } = dryRunVariant(variant, request, model);
      const diff = diffDocuments(before, after);
      if (
        overReaches(diff, variant, request.region) ||
        reachesOutsideRegion(variant, request.region)
      ) {
        reasons.push(`variant ${index + 1} "${variant.label}" reaches outside the region`);
      }
    } catch (failure) {
      reasons.push(
        `variant ${index + 1} "${variant.label}" could not be dry-run: ${
          failure instanceof Error ? failure.message : String(failure)
        }`,
      );
    }
  });
  return reasons.length === 0
    ? { count: 0 }
    : { count: reasons.length, detail: reasons.join("; ") };
}

/** Runs `worker` over `items` with at most `limit` in flight, preserving result order. */
async function mapConcurrent<Item, Result>(
  items: readonly Item[],
  limit: number,
  worker: (item: Item) => Promise<Result>,
): Promise<Result[]> {
  const results = new Array<Result>(items.length);
  let next = 0;
  const run = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await worker(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

/** Selects cases by exact ID or a simple `*` glob, comma-separated. */
export function selectCases(cases: readonly BenchCase[], spec: string | undefined): BenchCase[] {
  if (spec === undefined || spec.trim() === "") return [...cases];
  const patterns = spec
    .split(",")
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern !== "")
    .map((pattern) => new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`));
  return cases.filter((benchCase) => patterns.some((pattern) => pattern.test(benchCase.id)));
}

/** Escapes a literal for a regular expression. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Loads and validates `cases.json`. */
export function loadCases(path = join(BENCH_DIR, "cases.json")): BenchCase[] {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(raw) || !Array.isArray(raw.cases)) {
    throw new Error(`${path}: expected an object with a cases array`);
  }
  const cases = raw.cases.map((value, index) => parseCase(value, `${path}: cases[${index}]`));
  const ids = new Set<string>();
  for (const benchCase of cases) {
    if (ids.has(benchCase.id)) throw new Error(`${path}: duplicate case id "${benchCase.id}"`);
    ids.add(benchCase.id);
    const doc = loadFixture(benchCase.fixture);
    const problems = benchCase.region === undefined ? [] : regionInsideSong(doc, benchCase.region);
    if (problems.length > 0) {
      throw new Error(`${path}: case "${benchCase.id}": ${problems.join("; ")}`);
    }
  }
  return cases;
}

/** Parses and checks one case entry. */
function parseCase(value: unknown, where: string): BenchCase {
  if (!isRecord(value)) throw new Error(`${where}: expected an object`);
  const id = requiredString(value, "id", where);
  const fixture = requiredString(value, "fixture", where);
  const prompt = requiredString(value, "prompt", where);
  const region =
    value.region === undefined ? undefined : parseRegion(value.region, `${where}.region`);
  const uiContext = parseUiContext(value.uiContext, `${where}.uiContext`);
  const expectations = parseExpectations(value.expectations, `${where}.expectations`);
  if (region !== undefined && uiContext.view !== "moment") {
    throw new Error(`${where}: a region needs uiContext.view "moment"`);
  }
  return {
    id,
    fixture,
    prompt,
    uiContext,
    expectations,
    ...(region === undefined ? {} : { region }),
  };
}

/** A string field. */
function requiredString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== "string" || value === "") throw new Error(`${where}.${key}: string needed`);
  return value;
}

/** Parses a region with validated tracks. */
function parseRegion(value: unknown, where: string): Region {
  if (!isRecord(value)) throw new Error(`${where}: expected an object`);
  const startTick = requiredInteger(value, "startTick", where);
  const endTick = requiredInteger(value, "endTick", where);
  if (value.tracks === "all") return { startTick, endTick, tracks: "all" };
  if (!Array.isArray(value.tracks) || !value.tracks.every((track) => typeof track === "string")) {
    throw new Error(`${where}.tracks: "all" or a string array needed`);
  }
  return {
    startTick,
    endTick,
    tracks: value.tracks as string[],
    ...(value.freqRange === undefined ? {} : { freqRange: value.freqRange as [number, number] }),
  };
}

/** Parses the UI context. */
function parseUiContext(value: unknown, where: string): PlanRequest["uiContext"] {
  if (!isRecord(value)) throw new Error(`${where}: expected an object`);
  if (value.view !== "song" && value.view !== "moment") {
    throw new Error(`${where}.view: song or moment needed`);
  }
  return {
    view: value.view,
    selectedTrackIds: stringList(value.selectedTrackIds, `${where}.selectedTrackIds`),
    selectedSectionIds: stringList(value.selectedSectionIds, `${where}.selectedSectionIds`),
  };
}

/** Parses the expectations, accepting only the keys {@link Expectations} documents. */
function parseExpectations(value: unknown, where: string): Expectations {
  if (!isRecord(value)) throw new Error(`${where}: expected an object`);
  const expectations: Expectations = {};
  for (const [key, raw] of Object.entries(value)) {
    switch (key) {
      case "minVariants":
      case "maxVariants":
      case "distinctLeverTypes":
        expectations[key] = requiredInteger(value, key, where);
        break;
      case "onlyOpKinds":
      case "forbiddenOpKinds":
      case "touchesOnlyTracks":
      case "noTouch":
      case "noticeContains":
      case "forbiddenText":
      case "containsText":
      case "generationCapabilities":
        expectations[key] = stringList(raw, `${where}.${key}`);
        break;
      case "insideRegion":
      case "timeLimited":
      case "asksClarification":
      case "scopeSong":
      case "interpretationExcludesDropped":
      case "requiresGeneration":
      case "forbidsGeneration":
      case "atMostOneGenerativeVariant":
      case "generationInsideRegion":
        if (typeof raw !== "boolean") throw new Error(`${where}.${key}: boolean needed`);
        expectations[key] = raw;
        break;
      default:
        throw new Error(`${where}: unknown expectation "${key}"`);
    }
  }
  return expectations;
}

/** An integer field. */
function requiredInteger(record: Record<string, unknown>, key: string, where: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${where}.${key}: integer needed`);
  }
  return value;
}

/** A string array. */
function stringList(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${where}: string array needed`);
  }
  return value as string[];
}

/** Loads, validates and caches a fixture document. */
const fixtureCache = new Map<string, Project>();
export function loadFixture(name: string): Project {
  const cached = fixtureCache.get(name);
  if (cached !== undefined) return cached;
  const path = join(BENCH_DIR, "fixtures", `${name}.json`);
  if (!existsSync(path)) throw new Error(`bench fixture ${name} is missing (${path})`);
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!validateProject(parsed)) {
    const errors = (validateProject.errors ?? [])
      .slice(0, 5)
      .map((error) => `${error.instancePath}: ${error.message ?? "invalid"}`)
      .join("; ");
    throw new Error(`bench fixture ${name} does not validate: ${errors}`);
  }
  fixtureCache.set(name, parsed);
  return parsed;
}

/** Loads the committed recordings. */
function loadRecordings(path = RECORDINGS_PATH): Recordings {
  if (!existsSync(path)) {
    return { version: 1, model: "", recordedAt: "", cases: {} };
  }
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(raw) || !isRecord(raw.cases)) {
    throw new Error(`${path}: expected a recordings object`);
  }
  return raw as unknown as Recordings;
}

/**
 * Writes the recordings, merging with cases this run did not cover.
 *
 * @param recorded replies by case id
 * @param model the model that produced them
 * @param recordedAt the run's start
 * @param caseIds the cases that exist now; a renamed or removed case's replies are dropped, so the
 *   file cannot accumulate entries nothing selects
 */
function saveRecordings(
  recorded: Map<string, RecordedReply[]>,
  model: string,
  recordedAt: string,
  caseIds: readonly string[],
): void {
  const existing = loadRecordings();
  const known = new Set(caseIds);
  const cases: Record<string, { replies: RecordedReply[] }> = {};
  for (const [id, entry] of Object.entries(existing.cases)) {
    if (known.has(id)) cases[id] = entry;
  }
  for (const [id, replies] of recorded) cases[id] = { replies };
  const document: Recordings = { version: 1, model, recordedAt, cases };
  mkdirSync(dirname(RECORDINGS_PATH), { recursive: true });
  writeFileSync(RECORDINGS_PATH, `${JSON.stringify(document, null, 2)}\n`);
}

/** Computes the 06 §9 metrics from the runs. */
export function computeMetrics(runs: readonly CaseRun[]): BenchMetrics {
  const runsCount = runs.length;
  const valid = runs.filter((run) => run.valid).length;
  const passed = runs.filter((run) => run.valid && run.expectationPass).length;
  const latencies = runs.map((run) => run.latencyMs).sort((a, b) => a - b);
  const calls = runs.flatMap((run) => run.calls);
  const cost = calls.reduce<number | undefined>((sum, call) => {
    const value = call.usage?.costUsd;
    return value === undefined ? sum : (sum ?? 0) + value;
  }, undefined);
  return {
    runs: runsCount,
    valid,
    validRate: runsCount === 0 ? 0 : valid / runsCount,
    expectationPass: passed,
    expectationPassRate: runsCount === 0 ? 0 : passed / runsCount,
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
    overReach: runs.filter((run) => run.overReach).length,
    calls: calls.length,
    promptTokens: calls.reduce((sum, call) => sum + (call.usage?.promptTokens ?? 0), 0),
    completionTokens: calls.reduce((sum, call) => sum + (call.usage?.completionTokens ?? 0), 0),
    ...(cost === undefined ? {} : { costUsd: round(cost, 6) }),
  };
}

/** Nearest-rank percentile. */
function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(fraction * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank))] ?? 0;
}

/** Writes the JSON report and returns its path. */
function writeResults(summary: BenchSummary): string {
  const stamp = summary.startedAt.replaceAll(":", "-").replace(/\.\d+Z$/, "Z");
  const model = summary.model.replaceAll("/", "-");
  mkdirSync(RESULTS_DIR, { recursive: true });
  const path = join(RESULTS_DIR, `planner-${stamp}-${model}.json`);
  writeFileSync(path, `${JSON.stringify(summary, null, 2)}\n`);
  return path;
}

/** Prints the per-case table and the 06 §9 metrics. */
function printSummary(summary: BenchSummary): void {
  const rows = summary.runs.map((run) => ({
    id: run.id.slice(0, 30),
    tier: run.tier,
    calls: String(run.calls.length),
    ms: String(run.latencyMs),
    valid: run.valid ? "yes" : "no",
    exp: run.expectationPass ? "yes" : "no",
    drop: run.dropped.length === 0 ? "-" : String(run.dropped.length),
    notes: run.valid
      ? (run.checks.find((check) => !check.ok)?.detail ?? run.error ?? "")
      : (run.failureReasons?.[0] ?? run.error ?? ""),
  }));
  const widths = {
    id: Math.max(2, ...rows.map((row) => row.id.length)),
    tier: 5,
    calls: 5,
    ms: 6,
    valid: 5,
    exp: 5,
    drop: 4,
  };
  const header = [
    "ID".padEnd(widths.id),
    "TIER".padEnd(widths.tier),
    "CALLS".padEnd(widths.calls),
    "MS".padEnd(widths.ms),
    "VALID".padEnd(widths.valid),
    "EXP".padEnd(widths.exp),
    "DROP".padEnd(widths.drop),
    "NOTES",
  ].join("  ");
  console.log(
    `\nplanner bench · ${summary.model}${summary.dry ? " · dry replay" : ""} · ${summary.runs.length} run(s)`,
  );
  console.log(header);
  console.log("-".repeat(header.length));
  for (const row of rows) {
    console.log(
      [
        row.id.padEnd(widths.id),
        row.tier.padEnd(widths.tier),
        row.calls.padEnd(widths.calls),
        row.ms.padEnd(widths.ms),
        row.valid.padEnd(widths.valid),
        row.exp.padEnd(widths.exp),
        row.drop.padEnd(widths.drop),
        row.notes,
      ].join("  "),
    );
  }
  const { metrics } = summary;
  console.log("\n06 §9 metrics");
  console.log(
    `  valid plan rate       ${percent(metrics.validRate)}  (${metrics.valid}/${metrics.runs})`,
  );
  console.log(
    `  expectation pass rate ${percent(metrics.expectationPassRate)}  (${metrics.expectationPass}/${metrics.runs})`,
  );
  console.log(`  latency P50 / P95     ${metrics.p50LatencyMs} ms / ${metrics.p95LatencyMs} ms`);
  console.log(`  over-reach            ${metrics.overReach}`);
  console.log(
    `  calls / tokens        ${metrics.calls} calls · ${metrics.promptTokens} in · ${metrics.completionTokens} out`,
  );
  console.log(
    `  cost                  ${metrics.costUsd === undefined ? "not reported" : `$${metrics.costUsd}`}`,
  );
  if (summary.skipped.length > 0) {
    console.log(`  skipped               ${summary.skipped.length} case(s) without recordings`);
  }
  if (summary.resultsPath !== undefined) console.log(`\nreport: ${summary.resultsPath}`);
}

/** A ratio as a one-decimal percentage. */
function percent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

/** Rounds to one decimal (milliseconds and USD helpers). */
function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** A plain object, not an array or null. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The CLI entry point. */
async function cli(): Promise<void> {
  try {
    const summary = await main(process.argv.slice(2));
    // Over-reach is the one metric that must be zero (06 §7, §9); fail the run if it ever is not.
    if (summary.metrics.overReach > 0) process.exitCode = 1;
  } catch (failure) {
    if (failure instanceof HelpRequested) {
      console.log(usage());
      return;
    }
    console.error(
      `[bench:planner] ${failure instanceof Error ? failure.message : String(failure)}`,
    );
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await cli();
