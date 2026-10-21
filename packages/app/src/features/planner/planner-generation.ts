/**
 * A planner variant with `generate` steps, executed progressively (06 §5, 09 §5).
 *
 * ```
 * ops-only variants → candidate commits now (the existing instant path)
 * generative variant → render + upload each generate step's context → POST /plans/{id}/execute
 *   → job progress in the Audition bar → first passing partial: ops + placement + smooth ops
 *   → one candidate commit → Accept: analysis + HQ re-render
 * ```
 *
 * The plan is stored server-side (task C), so execute only carries the chosen variant indexes and
 * the rendered context assets. M2 demo 4 is this path with a faked `POST /v1/plans` and a real
 * job from the fake generation backend.
 */
import type {
  ApiClient,
  GenerationCapability,
  GenerationSubmit,
  RealtimeClient,
  RealtimeMessage,
} from "@bragi/api-client";
import type { BlobHash, Platform } from "@bragi/platform";
import type {
  ApplyGeneratedStep,
  AssetMeta,
  EditPlan,
  GenerateExtendResult,
  GenerateFillResult,
  GenerateStep,
  JobEvent,
  Op,
  OpBatch,
  PlanVariant,
  Project,
  Region,
  SmoothStep,
} from "@bragi/schemas";
import { validateGenerateExtendResult, validateGenerateFillResult } from "@bragi/schemas";

import { t } from "../../i18n/index.js";
import { ulid } from "../../lib/ulid.js";
import { uploadAsset } from "../analysis/api/upload.js";
import type { CandidateSource, CandidateStatus } from "../audition/state/candidate-status.js";
import { FILL_CONTEXT_SECONDS } from "../generation/state/adapters/inpaint.js";
import { SMOOTH_CONTEXT_BARS } from "../generation/state/adapters/transition.js";
import {
  barsEndingAt,
  barsStartingAt,
  rangeEndingAt,
  rangeStartingAt,
  samplesBetween,
} from "../generation/state/context-windows.js";
import {
  type ExtendCandidatePartial,
  type ExtendJob,
  extendCandidateAssets,
  extendCandidateBatch,
} from "../generation/state/extend-candidates.js";
import { applyGeneratedAnalysis } from "../generation/state/generated-analysis.js";
import { candidateEntry, type GenerationAudition } from "../generation/state/generation-session.js";
import { ticksPerBarAt, totalTicks } from "../generation/state/musical-context.js";
import { geometryFor } from "../generation/state/session-geometry.js";
import type { History } from "../history/state/history.js";
import { newBatchId } from "../song/state/ops.js";
import { sectionStartTick, smartTransitionTicks } from "../song/state/section-ops.js";
import type { Commit, SongStore } from "../song/state/song-store.js";
import { PLANNER_MODEL } from "./candidates.js";

export interface PlannerGenerationDependencies {
  readonly platform: Platform;
  readonly api: ApiClient;
  readonly realtime: RealtimeClient;
  readonly songStore: SongStore;
  readonly history: History;
  readonly renderContext: (
    range: { readonly startTick: number; readonly endTick: number },
    tracks?: readonly string[] | "all",
  ) => Promise<Uint8Array>;
  readonly audition: GenerationAudition;
  readonly fetch?: typeof globalThis.fetch;
  readonly hash?: (bytes: Uint8Array) => Promise<BlobHash>;
  readonly now?: () => Date;
  readonly onAnnounce?: (message: string) => void;
  readonly onCommit?: (commit: Commit, doc: Project) => void;
}

/** What the planner hands to execute: the plan, its prompt/region and the instant variants. */
export interface PlannerExecuteInput {
  readonly plan: EditPlan;
  readonly prompt: string;
  /** The lasso/selection in absolute ticks, for the bar's loop. */
  readonly region: Region;
  /** The already-built ops-only candidate batches. */
  readonly opsBatches: readonly OpBatch[];
}

/** What one accepted planner candidate needs for HQ and analysis. */
interface AcceptedCandidate {
  readonly assetHash: string;
  readonly step: GenerateStep;
  readonly variant: PlanVariant;
  readonly variantIndex: number;
  /** The job the candidate came from, for its rendered contexts and seed. */
  readonly job: StepJob;
  readonly seed: number;
}

/** One enqueued job of a generate step. */
interface StepJob {
  readonly jobId: string;
  readonly step: GenerateStep;
  readonly variant: PlanVariant;
  readonly variantIndex: number;
  /** The rendered context hashes, keyed by the job's input names. */
  readonly assets: Readonly<Record<string, string>>;
  /** The edge context range of an extend, so placement does not re-derive it. */
  readonly contextRange: { readonly startTick: number; readonly endTick: number } | null;
  published: boolean;
  lastRejected: { readonly assetHash: string; readonly json: unknown } | null;
}

export interface PlannerGeneration {
  readonly source: CandidateSource;
  /** Runs the plan's generative variants and opens the Audition bar. `false` when it fails. */
  execute(input: PlannerExecuteInput): Promise<boolean>;
  accepted(candidateId: string): void;
  discarded(group: string): void;
  group(): string | null;
  dispose(): void;
}

/** Whether a variant has a generate step (and therefore is executed server-side). */
export function hasGenerateStep(variant: PlanVariant): boolean {
  return variant.steps.some((step) => step.kind === "generate");
}

/** The generate steps of a variant, in order. */
export function generateSteps(variant: PlanVariant): GenerateStep[] {
  return variant.steps.filter((step): step is GenerateStep => step.kind === "generate");
}

/** A free-form numeric param, with a fallback. */
function numberParam(step: GenerateStep, key: string, fallback: number): number {
  const value = step.params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** A free-form string param. */
function stringParam(step: GenerateStep, key: string): string | undefined {
  const value = step.params[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * The ops a `smooth` step compiles to (06 §5 step 4).
 *
 * v1 compiles `crossfade` to a one-beat `section.set_transition` on every boundary inside the
 * region. `loudness_match` and `spectral_match` need `match_eq`, whose `bands` array cannot be
 * expressed in `FxParams` (03 §6), and `beat_align` is already a gate the generated audio passed
 * (09 §6), so those three are no-ops here; `docs/wp/2.8.md` records that.
 */
export function smoothOps(step: SmoothStep, doc: Project): Op[] {
  if (!step.tools.includes("crossfade")) return [];
  const ops: Op[] = [];
  const ticks = smartTransitionTicks(doc);
  for (const [index, section] of doc.arrangement.sections.entries()) {
    if (index === 0) continue;
    const start = sectionStartTick(doc, index);
    if (start < step.region.startTick || start > step.region.endTick) continue;
    ops.push({
      op: "section.set_transition",
      sectionId: section.id,
      transition: { kind: "crossfade", lengthTicks: ticks },
    });
  }
  return ops;
}

/** The label of the plan's generative variant, for the audition bar. */
function generativeVariants(plan: EditPlan): number[] {
  return plan.variants.flatMap((variant, index) => (hasGenerateStep(variant) ? [index] : []));
}

/** A capability check for the free-form step. */
function capabilityOf(step: GenerateStep): GenerationCapability | null {
  return step.capability === "generate.extend" ||
    step.capability === "generate.inpaint" ||
    step.capability === "generate.transition"
    ? step.capability
    : null;
}

/** Creates the planner's generation controller for one canvas. */
export function createPlannerGeneration(deps: PlannerGenerationDependencies): PlannerGeneration {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? (() => new Date());
  const listeners = new Map<string, Set<(candidateId: string, event: JobEvent) => void>>();
  const warnings = new Map<string, string>();
  const appliedStages = new Set<string>();
  const accepted = new Map<string, AcceptedCandidate>();
  const jobs = new Map<string, StepJob>();
  /** HQ re-render jobs, whose partials only need an announcement. */
  const hqJobs = new Set<string>();
  let group: string | null = null;
  let planId: string | null = null;
  let disposeSubscription: (() => void) | null = null;
  let disposed = false;
  /** Serialises partial handling so two jobs' candidates keep their arrival order. */
  let partials: Promise<void> = Promise.resolve();

  async function ensureAsset(hash: string): Promise<void> {
    if (await deps.platform.blobCache.has(hash as BlobHash)) return;
    const { url } = await deps.api.assetUrl(hash);
    const response = await doFetch(url);
    if (!response.ok) throw new Error(`could not download asset ${hash}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const stored = await deps.platform.blobCache.put(bytes);
    if (stored !== hash) throw new Error(`asset ${hash} hashed to ${stored}`);
  }

  async function downloadJson(hash: string): Promise<unknown> {
    const cached = await deps.platform.blobCache.get(hash as BlobHash);
    if (cached !== null) return JSON.parse(new TextDecoder().decode(cached));
    const { url } = await deps.api.assetUrl(hash);
    const response = await doFetch(url);
    if (!response.ok) throw new Error(`could not download blob ${hash}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const stored = await deps.platform.blobCache.put(bytes);
    if (stored !== hash) throw new Error(`blob ${hash} hashed to ${stored}`);
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  const source: CandidateSource = {
    subscribe(forGroup, listener) {
      const subscribers = listeners.get(forGroup) ?? new Set();
      subscribers.add(listener);
      listeners.set(forGroup, subscribers);
      return () => {
        subscribers.delete(listener);
        if (subscribers.size === 0) listeners.delete(forGroup);
      };
    },
    warning: (candidateId) => warnings.get(candidateId),
  };

  function emit(candidateId: string, type: "partial" | "completed" | "failed"): void {
    if (group === null) return;
    for (const listener of listeners.get(group) ?? []) {
      listener(candidateId, { schemaVersion: 1, jobId: group, type });
    }
  }

  function setQueue(status: CandidateStatus | null): void {
    deps.audition.setQueue(status);
  }

  /** Renders and uploads one generate step's context. */
  async function uploadContexts(step: GenerateStep): Promise<{
    assets: Record<string, string>;
    contextRange: { startTick: number; endTick: number } | null;
  }> {
    const geometry = geometryFor(deps.songStore);
    if (geometry === null) throw new Error("a plan needs a loaded project");
    const capability = capabilityOf(step);
    if (capability === null) throw new Error(`unknown generation capability ${step.capability}`);
    const tracks = step.context.tracks === "all" ? "all" : [...step.context.tracks];
    const upload = async (range: { startTick: number; endTick: number }): Promise<string> => {
      const bytes = await deps.renderContext(range, tracks);
      const uploaded = await uploadAsset(
        {
          platform: deps.platform,
          api: deps.api,
          ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
          ...(deps.hash === undefined ? {} : { hash: deps.hash }),
        },
        bytes,
        "audio/wav",
      );
      return uploaded.hash;
    };

    if (capability === "generate.extend") {
      const direction = stringParam(step, "direction") === "backward" ? "backward" : "forward";
      const range = JSON.parse(
        geometry.model.barAlignedContextRange(
          geometry.handle,
          direction === "forward" ? "end" : "start",
          30,
        ),
      ) as { startTick: number; endTick: number };
      return { assets: { context: await upload(range) }, contextRange: range };
    }
    const before = step.context.before;
    const after = step.context.after;
    if (before === undefined || after === undefined) {
      throw new Error(`the plan's ${capability} step has no context ranges`);
    }
    // The plan's ranges mark the gap (or boundary); the conditioning windows are the same ones the
    // Fill gap and Smooth chips render, so a short range written by the model cannot starve the
    // worker of the overlap and seam window it needs.
    const doc = deps.songStore.store.getState().doc;
    if (doc === null) throw new Error("a plan needs a loaded project");
    const windows =
      capability === "generate.transition"
        ? {
            before: barsEndingAt(doc, before.endTick, SMOOTH_CONTEXT_BARS),
            after: barsStartingAt(doc, after.startTick, SMOOTH_CONTEXT_BARS),
          }
        : {
            before: rangeEndingAt(doc, geometry, before.endTick, FILL_CONTEXT_SECONDS),
            after: rangeStartingAt(doc, geometry, after.startTick, FILL_CONTEXT_SECONDS),
          };
    return {
      assets: { before: await upload(windows.before), after: await upload(windows.after) },
      contextRange: null,
    };
  }

  /** The placement ops of one apply_generated step, from the candidate's result. */
  function placementOps(
    variant: PlanVariant,
    step: GenerateStep,
    job: StepJob,
    assetHash: string,
    json: unknown,
  ): { ops: Op[]; assets: AssetMeta[] } {
    const geometry = geometryFor(deps.songStore);
    const doc = deps.songStore.store.getState().doc;
    if (geometry === null || doc === null) throw new Error("a plan needs a loaded project");
    const apply = variant.steps.find(
      (entry): entry is ApplyGeneratedStep =>
        entry.kind === "apply_generated" && entry.from === step.id,
    );
    if (apply === undefined) return { ops: [], assets: [] };
    const capability = capabilityOf(step);
    const createdAt = now().toISOString();
    const sourceId = `src_${ulid()}`;
    const prompt = stringParam(step, "prompt");
    const provenance = {
      kind: "generation" as const,
      createdAt,
      jobId: job.jobId,
      ...(typeof json === "object" && json !== null && "model" in json
        ? { model: String((json as { model: unknown }).model) }
        : {}),
      ...(typeof json === "object" && json !== null && "modelVersion" in json
        ? { modelVersion: String((json as { modelVersion: unknown }).modelVersion) }
        : {}),
      ...(prompt === undefined ? {} : { prompt }),
    };
    const crossfade = Math.max(
      0,
      Math.min(960, Number(geometry.model.secondsToTicks(geometry.handle, 0.5))),
    );

    if (capability === "generate.extend" && validateGenerateExtendResult(json)) {
      const result: GenerateExtendResult = json;
      const bars = numberParam(step, "bars", 8);
      const overlap = numberParam(step, "overlapBars", 2);
      const anchor =
        result.direction === "forward"
          ? (job.contextRange?.endTick ?? totalTicks(doc))
          : (job.contextRange?.startTick ?? 0);
      const partial: ExtendCandidatePartial = {
        asset: {
          hash: assetHash,
          durationSamples: Math.max(
            1,
            Math.round(
              (bars + overlap) * geometry.barSamplesAt(anchor) + result.spliceOffsetSamples,
            ),
          ),
          channels: 2,
        },
        result: {
          spliceOffsetSamples: result.spliceOffsetSamples,
          qualityWarning: result.qualityWarning,
        },
      };
      const extendJob: ExtendJob = {
        group: job.jobId,
        direction: result.direction,
        bars,
        contextRange: job.contextRange ?? { startTick: 0, endTick: 0 },
        crossfadeTicks: crossfade,
        ...(prompt === undefined ? {} : { prompt }),
        ...(result.model === undefined ? {} : { model: result.model }),
        ...(result.modelVersion === undefined ? {} : { modelVersion: result.modelVersion }),
        jobId: job.jobId,
      };
      const batch = extendCandidateBatch(
        { songStore: deps.songStore },
        extendJob,
        partial,
        createdAt,
      );
      return { ops: [...batch.ops], assets: extendCandidateAssets(partial) };
    }

    if (
      (capability === "generate.inpaint" || capability === "generate.transition") &&
      validateGenerateFillResult(json)
    ) {
      const result: GenerateFillResult = json;
      if (capability === "generate.inpaint") {
        const gap = {
          startTick: apply.placement.region.startTick,
          endTick: apply.placement.region.endTick,
        };
        const gaps = samplesBetween(geometry, gap.startTick, gap.endTick);
        const overlaps = numberParam(step, "overlapBars", 2);
        const bars = numberParam(step, "gapBars", 1);
        const durationSamples = Math.max(
          gaps + Math.abs(result.startOffsetSamples) + Math.max(0, result.endOffsetSamples) + 1,
          Math.round((bars + 2 * overlaps) * geometry.barSamplesAt(gap.startTick)),
        );
        const batch = JSON.parse(
          deps.songStore.model.fillPlacement(
            geometry.handle,
            JSON.stringify({
              gapRange: gap,
              candidate: {
                sourceId,
                originalAsset: assetHash,
                workingAsset: assetHash,
                durationSamples,
                channels: 2,
                label: t("generation.fill.source"),
                provenance,
              },
              startOffsetSamples: result.startOffsetSamples,
              endOffsetSamples: result.endOffsetSamples,
              crossfadeTicks: crossfade,
              ...(apply.placement.region.tracks === "all"
                ? {}
                : { tracks: apply.placement.region.tracks }),
              batchId: `bat_${ulid()}`,
              label: variant.label,
              createdAt,
            }),
          ),
        ) as OpBatch;
        // `replace` (06 §3): the placement region's own audio goes first, in the same batch, so the
        // fill's later stems land in an empty gap instead of over the original clips.
        const clear: Op[] =
          apply.placement.mode === "replace"
            ? [{ op: "region.clear", region: apply.placement.region }]
            : [];
        return {
          ops: [...clear, ...batch.ops],
          assets: [assetMetaFor(assetHash, durationSamples)],
        };
      }
      const boundary = step.context.before?.endTick ?? apply.placement.region.startTick;
      const sectionId = sectionAtBoundary(doc, boundary);
      if (sectionId === null) throw new Error("the transition's boundary has no section");
      const lengthTicks = numberParam(step, "lengthBars", 2) * ticksPerBarAt(doc, boundary);
      const batch = JSON.parse(
        deps.songStore.model.transitionPlacement(
          geometry.handle,
          JSON.stringify({
            sectionId,
            candidate: {
              sourceId,
              originalAsset: assetHash,
              workingAsset: assetHash,
              durationSamples: Math.max(
                1,
                Math.round((lengthTicks / 960) * geometry.barSamplesAt(boundary)),
              ),
              channels: 2,
              label: t("generation.smooth.source"),
              provenance,
            },
            lengthTicks,
            batchId: `bat_${ulid()}`,
            label: variant.label,
            createdAt,
          }),
        ),
      ) as OpBatch;
      return {
        ops: [...batch.ops],
        assets: [assetMetaFor(assetHash, Math.max(1, geometry.barSamplesAt(boundary)))],
      };
    }
    return { ops: [], assets: [] };
  }

  /** Publishes one passing candidate: the variant's ops + placement + smooth, as one commit. */
  async function publish(
    job: StepJob,
    assetHash: string,
    json: unknown,
    qualityWarning: boolean,
  ): Promise<void> {
    if (job.published || group === null || disposed) return;
    job.published = true;
    const doc = deps.songStore.store.getState().doc;
    if (doc === null) return;
    await ensureAsset(assetHash);
    const placement = placementOps(job.variant, job.step, job, assetHash, json);
    const ops: Op[] = [
      ...job.variant.steps.flatMap((step) => (step.kind === "ops" ? [...step.ops] : [])),
      ...placement.ops,
      ...job.variant.steps.flatMap((step) => (step.kind === "smooth" ? smoothOps(step, doc) : [])),
    ];
    if (ops.length === 0) return;
    const batch: OpBatch = {
      id: newBatchId(),
      author: { kind: "ai", planId: planId ?? "", model: PLANNER_MODEL },
      label: job.variant.label,
      intent: job.variant.description,
      ops: ops as [Op, ...Op[]],
      createdAt: now().toISOString(),
    };
    deps.songStore.addAssets(placement.assets);
    const [commit] = await deps.history.addCandidates([batch], group);
    if (commit === undefined) return;
    accepted.set(commit.id, {
      assetHash,
      step: job.step,
      variant: job.variant,
      variantIndex: job.variantIndex,
      job,
      seed: numberFromResult(json) ?? 0,
    });
    if (qualityWarning) warnings.set(commit.id, t("generation.extend.qualityWarning"));
    setQueue(null);
    emit(commit.id, "partial");
    deps.onAnnounce?.(t("generation.extend.live.ideaReady", { index: 0 }));
  }

  function onMessage(message: RealtimeMessage): void {
    if (disposed) return;
    if ("jobId" in message && hqJobs.has(message.jobId)) {
      if (message.t === "job.partial") {
        void handleHqPartial(message).catch((error: unknown) => {
          console.warn("could not fetch the planner's HQ render", error);
          deps.onAnnounce?.(t("generation.extend.live.hqFailed"));
        });
      }
      return;
    }
    if (message.t === "job.progress") {
      const job = jobs.get(message.jobId);
      if (job === undefined) return;
      setQueue(
        message.pct === 0 && message.etaSec !== undefined
          ? { kind: "queued", etaSec: message.etaSec }
          : { kind: "generating", pct: Math.max(0, Math.min(1, message.pct)) },
      );
      return;
    }
    if (message.t === "job.partial") {
      const job = jobs.get(message.jobId);
      if (job === undefined) return;
      const asset = candidateEntry(message.outputs?.assets);
      const blob = candidateEntry(message.outputs?.blobs);
      if (asset === undefined || blob === undefined) return;
      partials = partials
        .then(async () => {
          const json = await downloadJson(blob.hash);
          if (passedResult(json)) {
            await publish(job, asset.hash, json, false);
            return;
          }
          // A rejected preview is only published when the job ends without a passing one.
          job.lastRejected = { assetHash: asset.hash, json };
        })
        .catch((error: unknown) => {
          console.warn("could not add a planner generation candidate", error);
          deps.onAnnounce?.(t("generation.extend.error.generic"));
        });
      return;
    }
    if (message.t === "job.completed") {
      const job = jobs.get(message.jobId);
      if (job === undefined) return;
      setQueue(null);
      // The partial chain may still be reading this job's last result; decide after it.
      partials = partials
        .then(async () => {
          if (job.published || job.lastRejected === null) return;
          const rejected = job.lastRejected;
          await publish(job, rejected.assetHash, rejected.json, true);
        })
        .catch((error: unknown) => {
          console.warn("could not add the planner's rejected candidate", error);
          deps.onAnnounce?.(t("generation.extend.error.generic"));
        });
      if ([...jobs.values()].every((entry) => entry.published)) setQueue(null);
      return;
    }
    if (message.t === "job.failed") {
      if (!jobs.has(message.jobId)) return;
      setQueue(null);
      deps.onAnnounce?.(t("generation.extend.error.generic"));
      return;
    }
    if (message.t === "analysis.partial") {
      const record = [...accepted.values()].find((entry) => entry.assetHash === message.assetHash);
      if (record === undefined) return;
      void handleAnalysis(record, message).catch((error: unknown) => {
        console.warn("could not apply the generated analysis", error);
      });
    }
  }

  async function handleHqPartial(
    message: Extract<RealtimeMessage, { t: "job.partial" }>,
  ): Promise<void> {
    const asset = candidateEntry(message.outputs?.assets);
    if (asset === undefined) return;
    await ensureAsset(asset.hash);
    deps.onAnnounce?.(t("generation.extend.live.hqReady"));
  }

  async function handleAnalysis(
    record: AcceptedCandidate,
    event: Extract<RealtimeMessage, { t: "analysis.partial" }>,
  ): Promise<void> {
    if (event.assetHash !== record.assetHash || appliedStages.has(event.stage)) return;
    appliedStages.add(event.stage);
    const json = await downloadJson(event.blob);
    const outcome = await applyGeneratedAnalysis(
      { songStore: deps.songStore, history: deps.history, ensureAsset, now },
      { assetHash: event.assetHash, stage: event.stage, blob: event.blob, json },
    );
    if (outcome.ok) {
      const doc = deps.songStore.store.getState().doc;
      if (doc !== null) deps.onCommit?.(outcome.commit, doc);
    }
  }

  async function queueAnalysis(record: AcceptedCandidate): Promise<void> {
    deps.realtime.subscribe([`asset:${record.assetHash}`]);
    try {
      await deps.api.postAnalyses(record.assetHash, "standard");
    } catch (error) {
      console.warn("could not queue the generated analysis", error);
      deps.onAnnounce?.(t("generation.extend.live.analysisFailed"));
    }
  }

  async function submitHq(record: AcceptedCandidate): Promise<void> {
    const doc = deps.songStore.store.getState().doc;
    if (doc === null) return;
    const capability = capabilityOf(record.step);
    if (capability === null) return;
    const seed = record.seed;
    const context =
      typeof record.step.params.context === "object" && record.step.params.context !== null
        ? record.step.params.context
        : {};
    const params = {
      ...record.step.params,
      context: { ...context, seed },
      seed,
      tier: "hq",
      n: 1,
    } as GenerationSubmit["params"];
    try {
      const posted = await deps.api.submitJob({
        capability,
        priority: "background",
        projectId: doc.id,
        assets: record.job.assets,
        params,
      });
      hqJobs.add(posted.jobId);
      deps.realtime.subscribe([`job:${posted.jobId}`]);
    } catch (error) {
      console.warn("could not queue the planner's HQ render", error);
      deps.onAnnounce?.(t("generation.extend.live.hqFailed"));
    }
  }

  return {
    source,
    async execute(input) {
      const indexes = generativeVariants(input.plan);
      if (indexes.length === 0) return false;
      if (deps.audition.isOpen()) {
        deps.onAnnounce?.(t("planner.error.auditionOpen"));
        return false;
      }
      disposed = false;
      const planGroup = input.plan.planId;
      group = planGroup;
      planId = planGroup;
      const geometry = geometryFor(deps.songStore);
      if (geometry === null) {
        deps.onAnnounce?.(t("generation.extend.error.noSong"));
        return false;
      }
      setQueue({ kind: "queued" });
      try {
        if (input.opsBatches.length > 0) {
          await deps.history.addCandidates(input.opsBatches, planGroup);
        }
        const opened = await deps.audition.open({
          group: planGroup,
          prompt: input.prompt,
          region: {
            startSec: geometry.secondsAt(input.region.startTick),
            endSec: geometry.secondsAt(input.region.endTick),
          },
          initialStatus: { kind: "hq" },
          allowEmpty: true,
        });
        if (!opened) {
          deps.onAnnounce?.(t("planner.error.auditionOpen"));
          return false;
        }
        // `open` starts a fresh group; the queue badge goes on after it.
        setQueue({ kind: "queued" });

        const contexts: Record<string, Record<string, string>> = {};
        const planned: {
          step: GenerateStep;
          variant: PlanVariant;
          variantIndex: number;
          assets: Record<string, string>;
          contextRange: { startTick: number; endTick: number } | null;
        }[] = [];
        for (const index of indexes) {
          const variant = input.plan.variants[index];
          if (variant === undefined) continue;
          for (const step of generateSteps(variant)) {
            const uploaded = await uploadContexts(step);
            contexts[step.id] = uploaded.assets;
            planned.push({
              step,
              variant,
              variantIndex: index,
              assets: uploaded.assets,
              contextRange: uploaded.contextRange,
            });
          }
        }
        const response = await deps.api.executePlan(input.plan.planId, { contexts });
        if (response.jobs.length === 0) {
          setQueue(null);
          deps.onAnnounce?.(t("generation.extend.error.generic"));
          return false;
        }
        disposeSubscription?.();
        disposeSubscription = deps.realtime.on(onMessage);
        for (const entry of response.jobs) {
          const source = planned.find((candidate) => candidate.step.id === entry.stepId);
          if (source === undefined) continue;
          jobs.set(entry.jobId, {
            jobId: entry.jobId,
            step: source.step,
            variant: source.variant,
            variantIndex: source.variantIndex,
            assets: source.assets,
            contextRange: source.contextRange,
            published: false,
            lastRejected: null,
          });
          deps.realtime.subscribe([`job:${entry.jobId}`]);
        }
        deps.onAnnounce?.(t("planner.live.ready", { count: input.opsBatches.length + 1 }));
        return true;
      } catch (error) {
        setQueue(null);
        console.warn("could not execute the planner's generation steps", error);
        deps.onAnnounce?.(t("generation.extend.error.generic"));
        return false;
      }
    },
    accepted(candidateId) {
      const record = accepted.get(candidateId);
      if (record === undefined) return;
      void queueAnalysis(record);
      void submitHq(record);
    },
    discarded(discardGroup) {
      if (group !== discardGroup) return;
      for (const job of jobs.values()) {
        if (!job.published) void deps.api.cancelJob(job.jobId).catch(() => undefined);
        deps.realtime.unsubscribe([`job:${job.jobId}`]);
      }
      for (const jobId of hqJobs) deps.realtime.unsubscribe([`job:${jobId}`]);
      hqJobs.clear();
      for (const record of accepted.values()) {
        deps.realtime.unsubscribe([`asset:${record.assetHash}`]);
      }
      disposeSubscription?.();
      disposeSubscription = null;
      jobs.clear();
      accepted.clear();
      group = null;
      setQueue(null);
    },
    group() {
      return group;
    },
    dispose() {
      disposed = true;
      disposeSubscription?.();
      disposeSubscription = null;
      for (const job of jobs.values()) {
        if (!job.published) void deps.api.cancelJob(job.jobId).catch(() => undefined);
        if (group !== null) deps.realtime.unsubscribe([`job:${job.jobId}`]);
      }
      for (const jobId of hqJobs) deps.realtime.unsubscribe([`job:${jobId}`]);
      hqJobs.clear();
      jobs.clear();
      listeners.clear();
      group = null;
    },
  };
}

/** The section that starts at `boundary`. */
function sectionAtBoundary(doc: Project, boundary: number): string | null {
  for (const [index, section] of doc.arrangement.sections.entries()) {
    if (index > 0 && sectionStartTick(doc, index) === boundary) return section.id;
  }
  return null;
}

/** Whether a result blob reports that it passed its gates. */
function passedResult(json: unknown): boolean {
  if (typeof json !== "object" || json === null) return false;
  return "passed" in json && (json as { passed: unknown }).passed === true;
}

/** A result blob's seed, when it has one. */
function numberFromResult(json: unknown): number | null {
  if (typeof json !== "object" || json === null) return null;
  const seed = (json as { seed?: unknown }).seed;
  return typeof seed === "number" ? seed : null;
}

/** The AssetIndex entry of a generated candidate. */
function assetMetaFor(hash: string, durationSamples: number): AssetMeta {
  return {
    hash,
    mime: "audio/flac",
    bytes: 0,
    sampleRate: 48_000,
    channels: 2,
    durationSamples: Math.max(1, durationSamples),
  };
}
