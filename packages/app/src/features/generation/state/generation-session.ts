/**
 * One generation request end to end (09 §4, §5; 07 §6).
 *
 * ```
 * per-capability plan (context ranges + params) → engine context render(s) → hash + upload
 *   → POST /v1/jobs (preview, n candidates) → job.partial → result blob → candidate commit
 *   → Audition → Accept: analysis (standard) + HQ re-render (background)
 * ```
 *
 * Extend, fill-gap and smooth-with-AI share this path; the capability differences live in a
 * {@link GenerationAdapter} (which ranges to render, which params to send, how a result blob is
 * validated and placed). Extend's behaviour and messages are the same as WP-2.7's dedicated flow;
 * see the deviation in `docs/wp/2.8.md` for the refactor.
 *
 * Plain TypeScript over injected clients, so the whole flow is testable with a fake API, a fake
 * socket and a fake engine render. The Song Store is the only writer of the document: a candidate
 * is one history candidate commit, and the generated asset's analysis stages go through
 * `generated-analysis`.
 */
import {
  type ApiClient,
  ApiClientError,
  type GenerationCapability,
  type GenerationSubmit,
  type JobAccepted,
  type RealtimeClient,
  type RealtimeMessage,
} from "@bragi/api-client";
import type { BlobHash, ContextRange, Platform } from "@bragi/platform";
import type { AssetMeta, JobEvent, OpBatch, Project, SectionKind } from "@bragi/schemas";
import { createStore, type StoreApi } from "zustand/vanilla";

import { t } from "../../../i18n/index.js";
import { uploadAsset } from "../../analysis/api/upload.js";
import type { OpenCandidatesOptions } from "../../audition/state/audition.js";
import type { CandidateSource, CandidateStatus } from "../../audition/state/candidate-status.js";
import type { History } from "../../history/state/history.js";
import type { ModelApi } from "../../song/model/model-api.js";
import type { Commit, SongStore } from "../../song/state/song-store.js";
import { applyGeneratedAnalysis } from "./generated-analysis.js";
import type { EnergyCurve } from "./musical-context.js";
import { geometryFor as documentGeometry } from "./session-geometry.js";

export type GenerationPhase =
  | "idle"
  | "rendering"
  | "uploading"
  | "submitting"
  | "generating"
  | "preview"
  | "accepted"
  | "cancelled"
  | "failed";

/** The flow's view of the request. */
export interface GenerationState {
  readonly phase: GenerationPhase;
  readonly jobId?: string;
  /** The job's progress, once the worker starts (09 §5). */
  readonly pct?: number;
  readonly etaSec?: number;
  /** How many candidates the job has published so far. */
  readonly candidates: number;
  /** A plain-language message for an error or a cancelled job. */
  readonly message?: string;
  /** The requested length, for a handle that echoes it. */
  readonly bars?: number;
  /** Extend's direction; other capabilities leave it out. */
  readonly direction?: string;
}

/** `disabled` when this server has no generation worker (09 §5). */
export type WarmupStatus = "idle" | "warming" | "warm" | "disabled";

/** The audition bar the flow opens and reports queue status to. */
export interface GenerationAudition {
  open(options: OpenCandidatesOptions): Promise<boolean>;
  setQueue(status: CandidateStatus | null): void;
  /** One group at a time (07 §6): the flow asks before it submits anything. */
  isOpen(): boolean;
}

export interface GenerationDependencies {
  readonly platform: Platform;
  readonly api: ApiClient;
  readonly realtime: RealtimeClient;
  readonly songStore: SongStore;
  readonly history: History;
  /** Renders a context range with the song's engine (03 §9). Injected so tests fake it. */
  readonly renderContext: (
    range: ContextRange,
    tracks?: readonly string[] | "all",
  ) => Promise<Uint8Array>;
  /** The bar the flow opens candidate groups in. */
  readonly audition: GenerationAudition;
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

/** The parts of a job event's output map the flow reads. */
export interface CandidateEntry {
  readonly index: number;
  readonly hash: string;
}

/** The song geometry one plan needs: model handle, bars and samples between ticks. */
export interface SessionGeometry {
  readonly model: ModelApi;
  readonly handle: number;
  /** Samples in the bar that contains `tick` at 48 kHz. */
  barSamplesAt(tick: number): number;
  /** Samples between two absolute ticks at 48 kHz. */
  samplesBetween(startTick: number, endTick: number): number;
  /** Seconds elapsed at `tick`. */
  secondsAt(tick: number): number;
} /** One conditioning asset to render and upload, under the job's input key. */
export interface RenderedContext {
  readonly key: "context" | "before" | "after";
  readonly range: ContextRange;
}

/** The generic params of the three capabilities (api-client's submit union). */
export type GenerationParams = GenerationSubmit["params"];

/** What an adapter decides before the flow renders anything. */
export interface GenerationPlan<Params extends GenerationParams> {
  readonly capability: GenerationCapability;
  readonly params: Params;
  readonly assets: readonly RenderedContext[];
  /** The affected span in seconds, for the Audition bar's auto-loop. */
  readonly region: { readonly startSec: number; readonly endSec: number };
  /** What the Audition bar calls the request. */
  readonly prompt: string;
  readonly candidateCount: number;
  /** The tick the candidate is anchored at (extend edge, gap start, boundary). */
  readonly anchorTick: number;
  readonly bars?: number;
  readonly direction?: string;
  /** A capability's generated length in ticks (a transition's bridge). */
  readonly lengthTicks?: number;
  readonly sectionKind?: SectionKind;
}

/** One finished candidate, as the adapter parses it from a partial. */
export interface CandidateAudio {
  /** The 0-based candidate index in the job's result blob. */
  readonly index: number;
  /** The 48 kHz working asset the clips play. */
  readonly assetHash: string;
  /** The bytes the worker produced, when the document should keep both hashes. */
  readonly originalAsset?: string;
  readonly durationSamples: number;
  readonly channels: 1 | 2;
  readonly qualityWarning?: boolean;
  readonly seed: number;
  readonly model?: string;
  readonly modelVersion?: string;
  /** The adapter's own gate result (typed in the adapter's placement). */
  readonly result: unknown;
}

/** The model batch that places one candidate, and the assets it references. */
export interface CandidatePlacement {
  readonly batch: OpBatch;
  readonly assets: readonly AssetMeta[];
}

/**
 * One capability's differences from the shared flow.
 *
 * `plan` decides the rendered ranges and the job params; `parse` validates the result blob the
 * partial carries; `placement` turns it into the candidate batch; `hq` re-submits the accepted
 * candidate with the same seed (09 §5).
 */
export interface GenerationAdapter<Request, Params extends GenerationParams> {
  readonly capability: GenerationCapability;
  plan(input: {
    readonly doc: Project;
    readonly geometry: SessionGeometry;
    readonly request: Request;
    readonly seed: number;
    readonly energy?: EnergyCurve;
    readonly readBlob: (hash: string) => Promise<unknown>;
  }): Promise<GenerationPlan<Params>>;
  parse(input: {
    readonly json: unknown;
    readonly assetHash: string;
    readonly plan: GenerationPlan<Params>;
    readonly geometry: SessionGeometry;
  }): CandidateAudio | null;
  placement(input: {
    readonly plan: GenerationPlan<Params>;
    readonly candidate: CandidateAudio;
    readonly songStore: SongStore;
    readonly geometry: SessionGeometry;
    readonly jobId: string;
    readonly now: () => Date;
  }): CandidatePlacement;
  hq?(input: {
    readonly plan: GenerationPlan<Params>;
    readonly candidate: CandidateAudio;
    readonly projectId: string;
    readonly assets: Readonly<Record<string, string>>;
  }): GenerationSubmit | null;
}

/** What the per-capability hooks and the workspace share. */
export interface GenerationFlow<Request> {
  /** The job events, keyed by candidate commit, for the Audition bar (07 §6). */
  readonly source: CandidateSource;
  readonly store: StoreApi<GenerationState>;
  /** Warms the generation pool once per canvas open (09 §5). */
  warmup(): Promise<WarmupStatus>;
  /** Renders, uploads and submits one request. `false` when another request is running. */
  start(request: Request): Promise<boolean>;
  /** The user accepted a candidate: queue its analysis and the HQ re-render. */
  accepted(candidateId: string): void;
  /** Discard or Escape: cancel the job the group belongs to (05 §4.4). */
  discarded(group: string): void;
  /** The audition group this flow owns now, if any. */
  group(): string | null;
  dispose(): void;
}

const INITIAL: GenerationState = { phase: "idle", candidates: 0 };

/** A store that is never running, for views without a generation host (the demo page). */
export const EMPTY_GENERATION_STORE: StoreApi<GenerationState> = createStore<GenerationState>(
  () => INITIAL,
);

/** The "candidate_<n>" entry of a job output map. */
export function candidateEntry(
  map: Readonly<Record<string, string>> | undefined,
): CandidateEntry | undefined {
  if (map === undefined) return undefined;
  for (const [key, hash] of Object.entries(map)) {
    const match = /^candidate_(\d+)$/.exec(key);
    if (match?.[1] !== undefined) return { index: Number(match[1]), hash };
  }
  return undefined;
}

/** A plain-language message for a generation failure (09 §5, 05 §2). */
export function generationErrorMessage(error: unknown): string {
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
  readonly candidate: CandidateAudio;
}

interface Session<Params extends GenerationParams> {
  readonly group: string;
  readonly plan: GenerationPlan<Params>;
  readonly assets: Readonly<Record<string, string>>;
  jobId: string | null;
  hqJobId: string | null;
  accepted: string | null;
  /** True once the group is closed (accepted, discarded or the canvas went away). */
  closed: boolean;
  readonly candidates: Map<string, CandidateRecord>;
  /** Candidate indices already placed; a re-delivered partial must not add a second commit. */
  readonly published: Set<number>;
}

/** Creates the shared flow for one capability. */
export function createGenerationFlow<Request, Params extends GenerationParams>(
  deps: GenerationDependencies,
  adapter: GenerationAdapter<Request, Params>,
): GenerationFlow<Request> {
  const store = createStore<GenerationState>(() => INITIAL);
  const doFetch = deps.fetch ?? globalThis.fetch;
  const seed = deps.seed ?? (() => Math.floor(Math.random() * 0xffff_ffff));
  const now = deps.now ?? (() => new Date());
  const listeners = new Map<string, Set<(candidateId: string, event: JobEvent) => void>>();
  const warnings = new Map<string, string>();
  const appliedStages = new Set<string>();
  let session: Session<Params> | null = null;
  let disposeJobSubscription: (() => void) | null = null;
  /** Partials are placed one at a time, so their commits keep the order they were published in. */
  let partials: Promise<void> = Promise.resolve();
  let cancelled = false;
  let warmupStatus: WarmupStatus = "idle";

  function set(patch: Partial<GenerationState>): void {
    store.setState({ ...store.getState(), ...patch });
  }

  function announce(message: string): void {
    deps.onAnnounce?.(message);
  }

  function fail(message: string): void {
    set({ phase: "failed", message });
    deps.onError?.(message);
  }

  /** The geometry of the current document handle, or `null` before a song is loaded. */
  function geometryFor(): SessionGeometry | null {
    return documentGeometry(deps.songStore);
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
    current: Session<Params>,
    event: Extract<RealtimeMessage, { t: "job.partial" }>,
    geometry: SessionGeometry,
  ): Promise<void> {
    // An accepted job is over for the bar; a late partial must not add a candidate on new HEAD.
    if (current.accepted !== null || current.closed || cancelled) return;
    const asset = candidateEntry(event.outputs?.assets);
    const blob = candidateEntry(event.outputs?.blobs);
    if (asset === undefined || blob === undefined) return;
    const json = await downloadJson(blob.hash);
    const candidate = adapter.parse({
      json,
      assetHash: asset.hash,
      plan: current.plan,
      geometry,
    });
    if (candidate === null) {
      throw new Error(`candidate ${blob.hash} is not a ${current.plan.capability} result`);
    }
    if (current.published.has(candidate.index)) return;
    current.published.add(candidate.index);
    await ensureAsset(candidate.assetHash);
    if (candidate.originalAsset !== undefined && candidate.originalAsset !== candidate.assetHash) {
      await ensureAsset(candidate.originalAsset);
    }

    const placement = adapter.placement({
      plan: current.plan,
      candidate,
      songStore: deps.songStore,
      geometry,
      jobId: current.jobId ?? "",
      now,
    });
    deps.songStore.addAssets(placement.assets);
    const [commit] = await deps.history.addCandidates([placement.batch], current.group);
    if (commit === undefined) return;
    current.candidates.set(commit.id, { assetHash: candidate.assetHash, candidate });
    if (candidate.qualityWarning === true) {
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
    announce(t("generation.extend.live.ideaReady", { index: candidate.index + 1 }));
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
      const geometry = geometryFor();
      if (geometry === null) return;
      partials = partials
        .then(() => handlePartial(current, message, geometry))
        .catch((error: unknown) => {
          console.warn(`could not add a ${adapter.capability} candidate`, error);
          fail(generationErrorMessage(error));
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
    const geometry = geometryFor();
    if (geometry === null || session === null) return;
    const candidate = adapter.parse({
      json,
      assetHash: candidateEntry(event.outputs?.assets)?.hash ?? "",
      plan: session.plan,
      geometry,
    });
    if (candidate === null) return;
    await ensureAsset(candidate.assetHash);
    announce(t("generation.extend.live.hqReady"));
  }

  /** `analysis.partial` for the accepted asset: route one stage through `analysis.apply`. */
  async function handleAnalysis(
    current: Session<Params>,
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
  async function submitHq(current: Session<Params>, record: CandidateRecord): Promise<void> {
    const doc = deps.songStore.store.getState().doc;
    if (doc === null || adapter.hq === undefined) return;
    const body = adapter.hq({
      plan: current.plan,
      candidate: record.candidate,
      projectId: doc.id,
      assets: current.assets,
    });
    if (body === null) return;
    try {
      const accepted: JobAccepted = await deps.api.submitJob(body);
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

  /** The flow must not run two jobs: one group at a time (07 §6). */
  function busy(state: GenerationState): boolean {
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
      const doc = deps.songStore.store.getState().doc;
      const geometry = geometryFor();
      if (doc === null || geometry === null) {
        fail(t("generation.extend.error.noSong"));
        return false;
      }
      cancelled = false;
      store.setState({ ...INITIAL, phase: "rendering" });
      try {
        const energy = deps.energy?.();
        const plan = await adapter.plan({
          doc,
          geometry,
          request,
          seed: seed(),
          ...(energy === undefined ? {} : { energy }),
          readBlob: downloadJson,
        });
        set({
          phase: "rendering",
          ...(plan.bars === undefined ? {} : { bars: plan.bars }),
          ...(plan.direction === undefined ? {} : { direction: plan.direction }),
        });

        const assets: Record<string, string> = {};
        for (const asset of plan.assets) {
          const bytes = await deps.renderContext(asset.range, "all");
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
          assets[asset.key] = uploaded.hash;
        }

        set({ phase: "submitting" });
        const submit: GenerationSubmit = {
          capability: plan.capability,
          priority: "interactive",
          projectId: doc.id,
          assets,
          params: plan.params,
        };
        const accepted = await deps.api.submitJob(submit);
        if (cancelled) {
          await deps.api.cancelJob(accepted.jobId).catch(() => undefined);
          return false;
        }

        const group = accepted.jobId;
        const current: Session<Params> = {
          group,
          plan,
          assets,
          jobId: accepted.jobId,
          hqJobId: null,
          accepted: null,
          closed: false,
          candidates: new Map(),
          published: new Set(),
        };
        const previous = session;
        if (previous !== null) previous.closed = true;
        session = current;
        appliedStages.clear();
        partials = Promise.resolve();
        set({
          phase: "generating",
          jobId: accepted.jobId,
          pct: 0,
          candidates: 0,
          ...(plan.bars === undefined ? {} : { bars: plan.bars }),
          ...(plan.direction === undefined ? {} : { direction: plan.direction }),
        });
        disposeJobSubscription?.();
        disposeJobSubscription = deps.realtime.on(onMessage);
        deps.realtime.subscribe([`job:${accepted.jobId}`]);
        const opened = await deps.audition.open({
          group,
          prompt: plan.prompt,
          region: plan.region,
          initialStatus: { kind: "queued" },
          allowEmpty: true,
        });
        if (!opened) {
          await deps.api.cancelJob(accepted.jobId).catch(() => undefined);
          fail(t("generation.extend.error.groupOpen"));
          return false;
        }
        deps.audition.setQueue({ kind: "queued" });
        announce(t("generation.extend.live.generating", { count: plan.candidateCount }));
        return true;
      } catch (error) {
        fail(generationErrorMessage(error));
        return false;
      }
    },
    accepted(candidateId) {
      const current = session;
      if (current === null) return;
      const record = current.candidates.get(candidateId);
      if (record === undefined) return;
      current.accepted = candidateId;
      current.closed = true;
      set({ phase: "accepted" });
      void queueAnalysis(record);
      void submitHq(current, record);
    },
    discarded(group) {
      const current = session;
      if (current === null || current.group !== group) return;
      cancelled = true;
      current.closed = true;
      if (current.jobId !== null && current.accepted === null) {
        void deps.api.cancelJob(current.jobId).catch((error: unknown) => {
          console.warn("could not cancel the generation job", error);
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
    group() {
      return session?.group ?? null;
    },
    dispose() {
      const current = session;
      if (current !== null) current.closed = true;
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
