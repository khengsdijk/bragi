/**
 * One `generate.extend` request end to end (09 §4.2, §5; 07 §4.2, §6).
 *
 * ```
 * bar-aligned context → engine context render → hash + upload
 *   → POST /v1/jobs (preview, n = 3) → job.partial → result blob → candidate commit + Audition
 *   → Accept: POST /analyses (standard) + HQ re-render (background)
 * ```
 *
 * Plain TypeScript over injected clients, so the whole flow is testable with a fake API, a fake
 * socket and a fake engine render. The Song Store is the only writer of the document: a candidate
 * is one history candidate commit (E1's `extend-candidates`), and the generated asset's analysis
 * stages go through E1's `generated-analysis` router.
 */
import {
  type ApiClient,
  ApiClientError,
  type JobAccepted,
  type RealtimeClient,
  type RealtimeMessage,
} from "@bragi/api-client";
import type { BlobHash, ContextRange, Platform } from "@bragi/platform";
import type { GenerateExtendParams, GenerateExtendResult, JobEvent, Project } from "@bragi/schemas";
import { validateGenerateExtendResult } from "@bragi/schemas";
import { createStore, type StoreApi } from "zustand/vanilla";

import { t } from "../../../i18n/index.js";
import { uploadAsset } from "../../analysis/api/upload.js";
import type { OpenCandidatesOptions } from "../../audition/state/audition.js";
import type { CandidateSource, CandidateStatus } from "../../audition/state/candidate-status.js";
import type { History } from "../../history/state/history.js";
import type { Commit, SongStore } from "../../song/state/song-store.js";
import {
  addExtendCandidates,
  type ExtendCandidatePartial,
  type ExtendJob,
} from "./extend-candidates.js";
import { applyGeneratedAnalysis } from "./generated-analysis.js";
import {
  type EnergyCurve,
  meterSignatureAt,
  musicalContextFor,
  totalTicks,
} from "./musical-context.js";

/** How much song the model hears as context (09 §4.2 step 1). */
export const CONTEXT_SECONDS = 30;
/** The overlap the gate pass splices in (09 §4.2 step 2). */
export const OVERLAP_BARS = 2;
/** Preview candidates per request (07 §6: three ideas). */
export const EXTEND_CANDIDATES = 3;
/** The bar counts the popover offers; 8 is the default (07 §4.2). */
export const EXTEND_BARS = [4, 8, 16] as const;
export type ExtendBarCount = (typeof EXTEND_BARS)[number];
export const DEFAULT_EXTEND_BARS: ExtendBarCount = 8;
/** The gate crossfade: one beat, capped at 500 ms (03 §8.2, config/generation_gates.toml). */
export const CROSSFADE_MAX_SEC = 0.5;

export type ExtendDirection = GenerateExtendParams["direction"];

/** What the user asked for in the popover. */
export interface ExtendRequest {
  readonly direction: ExtendDirection;
  readonly bars: ExtendBarCount;
  readonly prompt?: string;
}

export type ExtendPhase =
  | "idle"
  | "rendering"
  | "uploading"
  | "submitting"
  | "generating"
  | "preview"
  | "accepted"
  | "cancelled"
  | "failed";

/** The handle's view of the flow. */
export interface ExtendState {
  readonly phase: ExtendPhase;
  readonly direction?: ExtendDirection;
  readonly bars?: number;
  readonly jobId?: string;
  /** The job's progress, once the worker starts (09 §5). */
  readonly pct?: number;
  readonly etaSec?: number;
  /** How many candidates the job has published so far. */
  readonly candidates: number;
  /** A plain-language message for an error or a cancelled job. */
  readonly message?: string;
}

/** `disabled` when this server has no generation worker (09 §5). */
export type WarmupStatus = "idle" | "warming" | "warm" | "disabled";

/** The audition bar the flow opens and reports queue status to. */
export interface ExtendAudition {
  open(options: OpenCandidatesOptions): Promise<boolean>;
  setQueue(status: CandidateStatus | null): void;
  /** One group at a time (07 §6): the flow asks before it submits anything. */
  isOpen(): boolean;
}

export interface ExtendFlowDependencies {
  readonly platform: Platform;
  readonly api: ApiClient;
  readonly realtime: RealtimeClient;
  readonly songStore: SongStore;
  readonly history: History;
  /** Renders the context with the song's engine (03 §9). Injected so tests fake it. */
  readonly renderContext: (range: ContextRange) => Promise<Uint8Array>;
  /** The bar the flow opens candidate groups in. */
  readonly audition: ExtendAudition;
  /** The live energy skyline, for the MusicalContext (07 §2). */
  readonly energy?: () => EnergyCurve | undefined;
  /** Injected for tests; defaults to `fetch` (asset and blob downloads). */
  readonly fetch?: typeof globalThis.fetch;
  /** Injected for tests; defaults to the main-thread SHA-256. */
  readonly hash?: (bytes: Uint8Array) => Promise<BlobHash>;
  /** A 32-bit seed for the request; injected in tests. */
  readonly seed?: () => number;
  readonly now?: () => Date;
  readonly onAnnounce?: (message: string) => void;
  /** The flow failed; the handle shows the message and the live region repeats it. */
  readonly onError?: (message: string) => void;
  /** Forward an analysis or HQ commit to the engine (the workspace's controller). */
  readonly onCommit?: (commit: Commit, doc: Project) => void;
}

export interface ExtendFlow {
  /** The job events, keyed by candidate commit, for the Audition bar (07 §6). */
  readonly source: CandidateSource;
  readonly store: StoreApi<ExtendState>;
  /** Warms the generation pool once per canvas open (09 §5). */
  warmup(): Promise<WarmupStatus>;
  /** Renders, uploads and submits one extend. `false` when another request is running. */
  start(request: ExtendRequest): Promise<boolean>;
  /** The user accepted a candidate: queue its analysis and the HQ re-render. */
  accepted(candidateId: string): void;
  /** Discard or Escape: cancel the job the group belongs to (05 §4.4). */
  discarded(group: string): void;
  dispose(): void;
}

const INITIAL: ExtendState = { phase: "idle", candidates: 0 };

/** The "candidate_<n>" entry of a job output map. */
function candidateEntry(
  map: Readonly<Record<string, string>> | undefined,
): { index: number; hash: string } | undefined {
  if (map === undefined) return undefined;
  for (const [key, hash] of Object.entries(map)) {
    const match = /^candidate_(\d+)$/.exec(key);
    if (match?.[1] !== undefined) return { index: Number(match[1]), hash };
  }
  return undefined;
}

/** A plain-language message for a generation failure (09 §5, 05 §2). */
export function extendErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    switch (error.code) {
      case "INSUFFICIENT_CREDITS":
        return t("generation.extend.error.credits");
      case "GENERATION_BUSY":
      case "BUDGET_EXCEEDED":
        return t("generation.extend.error.busy");
      case "VALIDATION_FAILED":
        return t("generation.extend.error.invalid");
      case "UPSTREAM_UNAVAILABLE":
        return t("generation.extend.error.unavailable");
      default:
        return t("generation.extend.error.generic");
    }
  }
  if (error instanceof TypeError) return t("generation.extend.error.network");
  return t("generation.extend.error.generic");
}

interface CandidateRecord {
  readonly assetHash: string;
  readonly result: GenerateExtendResult;
}

interface Session {
  readonly group: string;
  readonly direction: ExtendDirection;
  readonly bars: ExtendBarCount;
  readonly prompt?: string;
  readonly contextAsset: string;
  readonly params: GenerateExtendParams;
  readonly job: ExtendJob;
  readonly region: { readonly startSec: number; readonly endSec: number };
  /** Where the new section starts: the song end for forward, 0 for an intro. */
  readonly spanTick: number;
  jobId: string | null;
  hqJobId: string | null;
  accepted: string | null;
  readonly candidates: Map<string, CandidateRecord>;
  /** Candidate indices already placed; a re-delivered partial must not add a second commit. */
  readonly published: Set<number>;
}

export function createExtendFlow(deps: ExtendFlowDependencies): ExtendFlow {
  const store = createStore<ExtendState>(() => INITIAL);
  const doFetch = deps.fetch ?? globalThis.fetch;
  const seed = deps.seed ?? (() => Math.floor(Math.random() * 0xffff_ffff));
  const now = deps.now ?? (() => new Date());
  const listeners = new Map<string, Set<(candidateId: string, event: JobEvent) => void>>();
  const warnings = new Map<string, string>();
  const appliedStages = new Set<string>();
  let session: Session | null = null;
  let disposeJobSubscription: (() => void) | null = null;
  let cancelled = false;
  let warmupStatus: WarmupStatus = "idle";

  function set(patch: Partial<ExtendState>): void {
    store.setState({ ...store.getState(), ...patch });
  }

  function announce(message: string): void {
    deps.onAnnounce?.(message);
  }

  function fail(message: string): void {
    set({ phase: "failed", message });
    deps.onError?.(message);
  }

  /** Caches a blob the document or a job names, downloading it once (01 §6 step 7). */
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

  /** The `MusicalContext` of the session, read from the document and the analysis blobs. */
  async function buildContext(input: {
    readonly request: ExtendRequest;
    readonly handle: number;
    readonly doc: Project;
    readonly contextRange: { readonly startTick: number; readonly endTick: number };
    readonly seed: number;
  }): Promise<GenerateExtendParams["context"]> {
    const energy = deps.energy?.();
    return musicalContextFor({
      doc: input.doc,
      model: deps.songStore.model,
      handle: input.handle,
      direction: input.request.direction,
      contextRange: input.contextRange,
      bars: input.request.bars,
      seed: input.seed,
      ...(input.request.prompt === undefined ? {} : { prompt: input.request.prompt }),
      ...(energy === undefined ? {} : { energy }),
      readBlob: (hash) => downloadJson(hash),
    });
  }

  /** The group event hub: the Audition bar subscribes for one group. */
  const source: CandidateSource = {
    subscribe(group, listener) {
      const subscribers = listeners.get(group) ?? new Set();
      subscribers.add(listener);
      listeners.set(group, subscribers);
      return () => {
        subscribers.delete(listener);
        if (subscribers.size === 0) listeners.delete(group);
      };
    },
    warning: (candidateId) => warnings.get(candidateId),
  };

  function emit(group: string, candidateId: string, event: JobEvent): void {
    for (const listener of listeners.get(group) ?? []) listener(candidateId, event);
  }

  /** One finished candidate: fetch its result blob, place it and publish it to the bar. */
  async function handlePartial(
    current: Session,
    event: Extract<RealtimeMessage, { t: "job.partial" }>,
  ): Promise<void> {
    // An accepted job is over for the bar; a late partial must not add a candidate on new HEAD.
    if (current.accepted !== null || cancelled) return;
    const asset = candidateEntry(event.outputs?.assets);
    const blob = candidateEntry(event.outputs?.blobs);
    if (asset === undefined || blob === undefined) return;
    const json = await downloadJson(blob.hash);
    if (!validateGenerateExtendResult(json)) {
      throw new Error(`candidate ${blob.hash} is not a GenerateExtendResult`);
    }
    const result = json;
    if (current.published.has(result.index)) return;
    current.published.add(result.index);
    const assetHash = result.asset ?? asset.hash;
    await ensureAsset(assetHash);

    const barSamples = barSamplesAt(deps.songStore, current.spanTick);
    // The processed audio starts at the splice offset and covers `bars + overlap` after it
    // (09 §6); the placement helper clamps the clip to this length.
    const durationSamples = Math.max(
      1,
      Math.round((current.bars + OVERLAP_BARS) * barSamples + result.spliceOffsetSamples),
    );
    const partial: ExtendCandidatePartial = {
      asset: { hash: assetHash, durationSamples, channels: 2 },
      result: {
        spliceOffsetSamples: result.spliceOffsetSamples,
        qualityWarning: result.qualityWarning,
      },
    };
    const job: ExtendJob = {
      ...current.job,
      model: result.model,
      modelVersion: result.modelVersion,
    };
    const [commit] = await addExtendCandidates(
      { songStore: deps.songStore, history: deps.history, now },
      job,
      [partial],
    );
    if (commit === undefined) return;
    current.candidates.set(commit.id, { assetHash, result });
    if (result.qualityWarning) {
      warnings.set(commit.id, t("generation.extend.qualityWarning"));
    }
    deps.audition.setQueue(null);
    if (current.accepted === null) {
      set({ phase: "generating", candidates: current.candidates.size });
    }
    emit(current.group, commit.id, {
      schemaVersion: 1,
      jobId: current.jobId ?? "",
      type: "partial",
    });
    announce(t("generation.extend.live.ideaReady", { index: result.index + 1 }));
  }

  /** One WebSocket message for this flow's jobs (preview first, HQ after accept). */
  function onMessage(message: RealtimeMessage): void {
    const current = session;
    if (current === null || cancelled) return;
    if (message.t === "job.progress" && message.jobId === current.jobId) {
      const status: CandidateStatus =
        message.pct === 0 && message.etaSec !== undefined
          ? { kind: "queued", etaSec: message.etaSec }
          : { kind: "generating", pct: Math.max(0, Math.min(1, message.pct)) };
      deps.audition.setQueue(status);
      set({
        phase: "generating",
        pct: status.kind === "generating" ? status.pct : 0,
        ...(message.etaSec === undefined ? {} : { etaSec: message.etaSec }),
      });
      return;
    }
    if (message.t === "job.partial" && message.jobId === current.jobId) {
      void handlePartial(current, message).catch((error: unknown) => {
        console.warn("could not add an extend candidate", error);
        fail(extendErrorMessage(error));
      });
      return;
    }
    if (message.t === "job.completed" && message.jobId === current.jobId) {
      deps.audition.setQueue(null);
      if (current.accepted === null && store.getState().phase !== "failed") {
        set({ phase: "preview" });
      }
      return;
    }
    if (message.t === "job.failed" && message.jobId === current.jobId) {
      fail(t("generation.extend.error.generic"));
      return;
    }
    if (message.t === "job.partial" && message.jobId === current.hqJobId) {
      void handleHq(message).catch((error: unknown) => {
        console.warn("could not fetch the HQ render", error);
        announce(t("generation.extend.live.hqFailed"));
      });
      return;
    }
    if (message.t === "job.failed" && message.jobId === current.hqJobId) {
      announce(t("generation.extend.live.hqFailed"));
      return;
    }
    if (message.t === "analysis.partial" && current.candidates.size > 0) {
      void handleAnalysis(current, message).catch((error: unknown) => {
        console.warn("could not apply generated analysis", error);
      });
    }
  }

  /** The HQ re-render of an accepted candidate: same seed, one candidate, background (09 §5). */
  async function handleHq(event: Extract<RealtimeMessage, { t: "job.partial" }>): Promise<void> {
    const blob = candidateEntry(event.outputs?.blobs);
    if (blob === undefined) return;
    const json = await downloadJson(blob.hash);
    if (!validateGenerateExtendResult(json)) return;
    await ensureAsset(json.asset);
    announce(t("generation.extend.live.hqReady"));
  }

  /** `analysis.partial` for the accepted asset: route one stage through `analysis.apply`. */
  async function handleAnalysis(
    current: Session,
    event: Extract<RealtimeMessage, { t: "analysis.partial" }>,
  ): Promise<void> {
    const accepted = current.accepted;
    if (accepted === null) return;
    const record = current.candidates.get(accepted);
    if (record === undefined || event.assetHash !== record.assetHash) return;
    if (appliedStages.has(event.stage)) return;
    appliedStages.add(event.stage);
    const json = await downloadJson(event.blob);
    const outcome = await applyGeneratedAnalysis(
      { songStore: deps.songStore, history: deps.history, ensureAsset, now },
      { assetHash: event.assetHash, stage: event.stage, blob: event.blob, json },
    );
    if (outcome.ok) deps.onCommit?.(outcome.commit, outcome.doc);
  }

  /** Submits the HQ re-render after an accept; a failure is a soft message, not an error. */
  async function submitHq(current: Session, record: CandidateRecord): Promise<void> {
    try {
      const accepted: JobAccepted = await deps.api.submitJob({
        capability: "generate.extend",
        priority: "background",
        projectId: projectIdOf(deps.songStore),
        assets: { context: current.contextAsset },
        params: {
          ...current.params,
          context: { ...current.params.context, seed: record.result.seed },
          tier: "hq",
          n: 1,
        },
      });
      current.hqJobId = accepted.jobId;
      deps.realtime.subscribe([`job:${accepted.jobId}`]);
    } catch (error) {
      console.warn("could not queue the HQ render", error);
      announce(t("generation.extend.live.hqFailed"));
    }
  }

  /** Queues `standard` analysis of the accepted candidate and its stage routing (09 §4.2 step 4). */
  async function queueAnalysis(record: CandidateRecord): Promise<void> {
    // Subscribe first: the server replays finished stages on `sub`, so a fast `standard` profile
    // cannot finish before this client hears about it.
    deps.realtime.subscribe([`asset:${record.assetHash}`]);
    try {
      await deps.api.postAnalyses(record.assetHash, "standard");
    } catch (error) {
      console.warn("could not queue the generated analysis", error);
      announce(t("generation.extend.live.analysisFailed"));
    }
  }

  function barSamplesAt(songStore: SongStore, tick: number): number {
    const handle = songStore.handle();
    const doc = songStore.store.getState().doc;
    if (handle === null || doc === null) return 0;
    const model = songStore.model;
    const ticks = ticksPerBarAt(doc, tick);
    const startSec = secondsAt(model, handle, tick);
    const endSec = secondsAt(model, handle, tick + ticks);
    return Math.max(1, Math.round((endSec - startSec) * 48_000));
  }

  /** The flow must not run two jobs: one group at a time (07 §6). */
  function busy(state: ExtendState): boolean {
    return ["rendering", "uploading", "submitting", "generating"].includes(state.phase);
  }

  return {
    source,
    store,
    async warmup() {
      if (warmupStatus !== "idle") return warmupStatus;
      try {
        const response = await deps.api.warmupGeneration();
        warmupStatus = response.status;
      } catch (error) {
        // A warm-up ping is an optimisation (09 §5); a failure leaves the option usable.
        console.warn("could not warm the generator", error);
        warmupStatus = "idle";
      }
      return warmupStatus;
    },
    async start(request) {
      if (busy(store.getState())) return false;
      if (deps.audition.isOpen()) {
        fail(t("generation.extend.error.groupOpen"));
        return false;
      }
      const handle = deps.songStore.handle();
      const doc = deps.songStore.store.getState().doc;
      if (handle === null || doc === null) {
        fail(t("generation.extend.error.noSong"));
        return false;
      }
      cancelled = false;
      set({ phase: "rendering", direction: request.direction, bars: request.bars, candidates: 0 });
      try {
        const rangeJson = deps.songStore.model.barAlignedContextRange(
          handle,
          request.direction === "forward" ? "end" : "start",
          CONTEXT_SECONDS,
        );
        const contextRange = JSON.parse(rangeJson) as ContextRange;
        const contextSeed = seed();
        const musical = await buildContext({
          request,
          handle,
          doc,
          contextRange,
          seed: contextSeed,
        });
        const bytes = await deps.renderContext(contextRange);
        if (cancelled) return false;
        set({ phase: "uploading" });
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

        const params: GenerateExtendParams = {
          context: musical,
          bars: request.bars,
          overlapBars: OVERLAP_BARS,
          direction: request.direction,
          ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
          tier: "preview",
          n: EXTEND_CANDIDATES,
        };
        set({ phase: "submitting" });
        const accepted = await deps.api.submitJob({
          capability: "generate.extend",
          priority: "interactive",
          projectId: doc.id,
          assets: { context: uploaded.hash },
          params,
        });
        if (cancelled) {
          await deps.api.cancelJob(accepted.jobId).catch(() => undefined);
          return false;
        }

        const total = totalTicks(doc);
        const ticksPerBar = ticksPerBarAt(doc, total);
        const startTick = request.direction === "forward" ? contextRange.endTick : 0;
        const endTick =
          request.direction === "forward"
            ? total + request.bars * ticksPerBar
            : request.bars * ticksPerBar;
        const region = {
          startSec: secondsAt(deps.songStore.model, handle, startTick),
          endSec: secondsAt(deps.songStore.model, handle, endTick),
        };
        const group = accepted.jobId;
        const current: Session = {
          group,
          direction: request.direction,
          bars: request.bars,
          ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
          contextAsset: uploaded.hash,
          params,
          job: {
            group,
            direction: request.direction,
            bars: request.bars,
            contextRange,
            crossfadeTicks: crossfadeTicks(deps.songStore),
            ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
            ...(params.context.sectionKind === undefined
              ? {}
              : { sectionKind: params.context.sectionKind }),
            jobId: accepted.jobId,
          },
          region,
          spanTick: request.direction === "forward" ? total : 0,
          jobId: accepted.jobId,
          hqJobId: null,
          accepted: null,
          candidates: new Map(),
          published: new Set(),
        };
        session = current;
        appliedStages.clear();
        set({ phase: "generating", jobId: accepted.jobId, pct: 0, candidates: 0 });
        disposeJobSubscription?.();
        disposeJobSubscription = deps.realtime.on(onMessage);
        deps.realtime.subscribe([`job:${accepted.jobId}`]);
        const opened = await deps.audition.open({
          group,
          prompt:
            request.prompt ??
            t(
              request.direction === "forward"
                ? "generation.extend.promptForward"
                : "generation.extend.promptBackward",
              { bars: request.bars },
            ),
          region,
          initialStatus: { kind: "queued" },
          allowEmpty: true,
        });
        if (!opened) {
          await deps.api.cancelJob(accepted.jobId).catch(() => undefined);
          fail(t("generation.extend.error.groupOpen"));
          return false;
        }
        deps.audition.setQueue({ kind: "queued" });
        announce(t("generation.extend.live.generating", { count: EXTEND_CANDIDATES }));
        return true;
      } catch (error) {
        fail(extendErrorMessage(error));
        return false;
      }
    },
    accepted(candidateId) {
      const current = session;
      if (current === null) return;
      const record = current.candidates.get(candidateId);
      if (record === undefined) return;
      current.accepted = candidateId;
      set({ phase: "accepted" });
      void queueAnalysis(record);
      void submitHq(current, record);
    },
    discarded(group) {
      const current = session;
      if (current === null || current.group !== group) return;
      cancelled = true;
      if (current.jobId !== null && current.accepted === null) {
        void deps.api.cancelJob(current.jobId).catch((error: unknown) => {
          console.warn("could not cancel the extend job", error);
        });
      }
      disposeJobSubscription?.();
      disposeJobSubscription = null;
      deps.realtime.unsubscribe([`job:${current.jobId ?? ""}`]);
      if (current.hqJobId !== null) deps.realtime.unsubscribe([`job:${current.hqJobId}`]);
      for (const record of current.candidates.values()) {
        deps.realtime.unsubscribe([`asset:${record.assetHash}`]);
      }
      set({ phase: "cancelled", message: t("generation.extend.live.cancelled") });
      announce(t("generation.extend.live.cancelled"));
    },
    dispose() {
      const current = session;
      if (current !== null && current.jobId !== null && current.accepted === null && !cancelled) {
        void deps.api.cancelJob(current.jobId).catch(() => undefined);
      }
      disposeJobSubscription?.();
      disposeJobSubscription = null;
      if (current !== null) {
        deps.realtime.unsubscribe([`job:${current.jobId ?? ""}`]);
        if (current.hqJobId !== null) deps.realtime.unsubscribe([`job:${current.hqJobId}`]);
        for (const record of current.candidates.values()) {
          deps.realtime.unsubscribe([`asset:${record.assetHash}`]);
        }
      }
      listeners.clear();
      session = null;
    },
  };
}

/** The project the job belongs to (`submitJob` needs it). */
function projectIdOf(songStore: SongStore): string {
  const doc = songStore.store.getState().doc;
  if (doc === null) throw new Error("an extend needs a loaded project");
  return doc.id;
}

/** The number of ticks in the bar that contains `tick`. */
function ticksPerBarAt(doc: Project, tick: number): number {
  const meter = meterSignatureAt(doc, tick);
  const ppq = doc.arrangement.timebase.ppq;
  return Math.max(1, Math.round((ppq * 4 * meter.numerator) / meter.denominator));
}

/** Seconds elapsed at `tick`; the wasm boundary carries ticks as `bigint`. */
function secondsAt(model: SongStore["model"], handle: number, tick: number): number {
  return Number(model.ticksToSeconds(handle, BigInt(Math.round(tick))));
}

/** The gate's crossfade at the splice: one beat, capped at 500 ms (03 §8.2). */
function crossfadeTicks(songStore: SongStore): number {
  const handle = songStore.handle();
  const doc = songStore.store.getState().doc;
  if (handle === null || doc === null) return 0;
  const cap = Number(songStore.model.secondsToTicks(handle, CROSSFADE_MAX_SEC));
  return Math.max(0, Math.min(doc.arrangement.timebase.ppq, cap));
}
