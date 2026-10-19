/**
 * The upload-to-live-analysis flow controller (01 §6, 07 §8).
 *
 * ```
 * drop → SHA-256 → dedupe → presigned PUT → complete → POST /analyses
 *      → asset:<hash> → analysis.partial → blob → analysis.apply → canvas
 * ```
 *
 * It is plain TypeScript with injected dependencies (API, realtime, platform,
 * Song Store), so the whole flow is testable with a fake API and a fake socket.
 * The Song Store is the *only* writer of the document: every stage is one
 * `analysis.apply` batch authored by `system`, and TypeScript never edits the
 * document object.
 *
 * The project is created when `ingest` lands, not on drop: the `Source` needs
 * the working asset and its duration, which only ingest produces (finding 11).
 * Until then the UI shows the plain-language progress state.
 */
import type {
  AnalysisStageStatus,
  ApiClient,
  RealtimeClient,
  RealtimeMessage,
} from "@bragi/api-client";
import type { BlobHash, Platform } from "@bragi/platform";
import type { AnalysisStage, AssetMeta, Project, SeparationResult } from "@bragi/schemas";
import { validateIngestResult, validateSeparationResult } from "@bragi/schemas";
import {
  createProjectWithSnapshot,
  newProjectId,
  saveProjectSnapshot,
} from "../../library/api/library-repo.js";
import type { AnalysisData } from "../../song/components/SongWorkspace.js";
import type { Commit, SongStore } from "../../song/state/song-store.js";
import {
  artifactsForStage,
  mergeArtifacts,
  type StageArtifacts,
  type TrackRef,
} from "../api/analysis-view.js";
import { analysisBatch, createInitialProject, type InitialProject } from "../api/document.js";
import { sha256Hex } from "../api/hash.js";
import { asAnalysisStage, effectsForStage } from "../api/stage-effects.js";

/** The implemented stages of the `standard` profile (matches the API's DAG gate). */
export const STANDARD_STAGES: readonly AnalysisStage[] = [
  "ingest",
  "rhythm",
  "loudness_energy",
  "embed_full",
  "tag",
  "separation",
  "structure",
  "harmony",
  "stem_activity",
  "section_embed",
  "stem_embed",
];

/**
 * Stages the client merges when they arrive but does not wait for: `describe` needs an LLM
 * and may legitimately fail (no key) without making the song any less usable.
 */
const OPTIONAL_STAGES: readonly AnalysisStage[] = ["describe"];

export type UploadPhase =
  | "hashing"
  | "checking"
  | "uploading"
  | "queueing"
  | "analysing"
  | "ready"
  | "failed";

/** The plain-language progress state the UI renders (11 §8). */
export interface UploadState {
  readonly phase: UploadPhase;
  readonly assetHash?: string;
  readonly projectId?: string;
  readonly stage?: string;
  readonly stagesDone: number;
  readonly stagesTotal: number;
  readonly message?: string;
}

export interface PickedAudio {
  readonly name: string;
  bytes(): Promise<Uint8Array>;
}

export interface FlowDependencies {
  readonly platform: Platform;
  readonly api: ApiClient;
  readonly realtime: RealtimeClient;
  readonly songStore: SongStore;
  /** Injected for tests; defaults to `fetch`. Downloads a presigned URL. */
  readonly fetch?: typeof globalThis.fetch;
  /** Injected for tests; defaults to the Web Worker hasher's main-thread path. */
  readonly hash?: (bytes: Uint8Array) => Promise<BlobHash>;
  readonly onState?: (state: UploadState) => void;
  readonly onAnalysis?: (data: AnalysisData) => void;
  readonly onProject?: (projectId: string) => void;
  /** Called after every document change the flow makes, so a live engine can follow. */
  readonly onCommit?: (commit: Commit, doc: Project) => void;
  readonly now?: () => Date;
}

export interface UploadFlow {
  /** Runs the flow once. Resolves when the project exists (ingest landed). */
  start(file: PickedAudio): Promise<{ projectId: string; assetHash: string }>;
  /**
   * Continues the analysis of a project that is already open (reload, or navigation away from
   * the drop zone, Q82). `songStore` must hold the project's stored document; stages the document
   * already records are skipped, the rest are replayed from the server and merged as they land.
   * Resolves once every stage the server has finished so far is merged.
   */
  resume(input: { assetHash: string; view?: AnalysisData }): Promise<void>;
  /** The state after the last update. */
  state(): UploadState;
  dispose(): void;
}

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  wav: "audio/wav",
  flac: "audio/flac",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  opus: "audio/opus",
};

/** A content type from a file name; `application/octet-stream` when unknown. */
export function guessMime(filename: string): string {
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

/** The title shown for a dropped file: the name without its extension. */
export function titleFromFilename(filename: string): string {
  return filename.replace(/\.[^.]+$/, "").trim() || filename;
}

/** Creates the flow. It registers one realtime handler; {@link UploadFlow.dispose} removes it. */
export function createUploadFlow(deps: FlowDependencies): UploadFlow {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const hashBytes = deps.hash ?? sha256Hex;
  const now = deps.now ?? (() => new Date());

  let state: UploadState = { phase: "hashing", stagesDone: 0, stagesTotal: STANDARD_STAGES.length };
  let assetHash: string | null = null;
  let filename = "";
  let title = "";
  let projectId: string | null = null;
  let sourceId: string | null = null;
  let ingested = false;
  let started = false;
  let finished = false;
  let disposed = false;
  let view: StageArtifacts = {};
  const applied = new Set<string>();

  function emit(patch: Partial<UploadState>): void {
    state = { ...state, ...patch };
    deps.onState?.(state);
  }

  function tracks(): TrackRef[] {
    const doc = deps.songStore.store.getState().doc;
    return doc === null ? [] : doc.tracks.map((track) => ({ id: track.id, role: track.role }));
  }

  async function downloadJson(hash: string): Promise<unknown> {
    // The blob is immutable and content-addressed, so a cache hit is the same
    // bytes the worker uploaded. `put` re-verifies the hash.
    const cached = await deps.platform.blobCache.get(hash as BlobHash);
    if (cached !== null) return JSON.parse(new TextDecoder().decode(cached));
    const { url } = await deps.api.assetUrl(hash);
    const response = await doFetch(url);
    if (!response.ok) throw new Error(`could not download analysis blob ${hash}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const stored = await deps.platform.blobCache.put(bytes);
    if (stored !== hash) throw new Error(`analysis blob ${hash} hashed to ${stored}`);
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  /** Downloads one audio asset into the BlobCache (used for the stems, 01 §6 step 7). */
  async function ensureAsset(hash: string): Promise<void> {
    if (await deps.platform.blobCache.has(hash as BlobHash)) return;
    const { url } = await deps.api.assetUrl(hash);
    const response = await doFetch(url);
    if (!response.ok) throw new Error(`could not download asset ${hash}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const stored = await deps.platform.blobCache.put(bytes);
    if (stored !== hash) throw new Error(`asset ${hash} hashed to ${stored}`);
  }

  async function applyStage(stage: AnalysisStage, blob: string, json: unknown): Promise<void> {
    const effects = effectsForStage(stage, json);
    const separation = stage === "separation" && validateSeparationResult(json) ? json : null;

    if (separation !== null) {
      // The stems and residual must be in the AssetIndex before the op, so
      // `analysis.apply` can validate their clip ranges (02 §6).
      deps.songStore.addAssets(stemAssetMetas(separation, deps.songStore));
      // And in the BlobCache before the engine hears about the new tracks (`onCommit` resyncs the
      // engine from the document and reads the bytes from the cache): a stem the cache does not
      // have yet plays as silence. Stems appear as soon as separation lands (07 §8); a large
      // song's stems could be made lazier per ribbon (Q80).
      await ensureAsset(separation.residual);
      for (const stem of separation.stems) await ensureAsset(stem.asset);
    }

    if (stage === "ingest") {
      if (!validateIngestResult(json)) throw new Error("ingest blob is not an IngestResult");
      if (!ingested) {
        const initial: InitialProject = createInitialProject({
          projectId: newProjectId(),
          title,
          assetHash: assetHash as string,
          ingest: json,
          createdAt: now().toISOString(),
        });
        deps.songStore.load(initial.project, initial.assets);
        sourceId = initial.sourceId;
        const outcome = deps.songStore.apply(
          analysisBatch(initial.sourceId, "ingest", blob as BlobHash, []),
        );
        if (!outcome.ok) {
          throw new Error(
            `bragi-model rejected the ingest batch: ${JSON.stringify(outcome.errors)}`,
          );
        }
        deps.onCommit?.(outcome.commit, outcome.doc);
        const created = await createProjectWithSnapshot(deps.platform, {
          project: outcome.doc,
          assetHash: assetHash as string,
          filename,
          title,
          now: now(),
        });
        // The working asset is a re-encode, not the upload, so it has to reach
        // the BlobCache before the engine can play the full mix.
        await ensureAsset(json.workingAsset);
        projectId = created.projectId;
        ingested = true;
        emit({ projectId });
        deps.onProject?.(created.projectId);
        view = mergeArtifacts(view, artifactsForStage(stage, json, { tracks: tracks() }));
        return;
      }
    } else if (sourceId !== null && deps.songStore.handle() !== null) {
      const outcome = deps.songStore.apply(
        analysisBatch(sourceId, stage, blob as BlobHash, effects),
      );
      if (!outcome.ok) {
        throw new Error(`bragi-model rejected ${stage}: ${JSON.stringify(outcome.errors)}`);
      }
      deps.onCommit?.(outcome.commit, outcome.doc);
      await saveProjectSnapshot(deps.platform, outcome.doc, now());
    }

    view = mergeArtifacts(view, artifactsForStage(stage, json, { tracks: tracks() }));
    deps.onAnalysis?.(view as AnalysisData);
  }

  async function handlePartial(message: { stage: string; blob: string }): Promise<void> {
    if (disposed) return;
    const stage = asAnalysisStage(message.stage);
    if (stage === undefined || applied.has(stage)) return;
    if (!STANDARD_STAGES.includes(stage) && !OPTIONAL_STAGES.includes(stage)) return;
    if (!finished) emit({ phase: "analysing", stage });
    try {
      const json = await downloadJson(message.blob);
      await applyStage(stage, message.blob, json);
      applied.add(stage);
      emit({ stagesDone: STANDARD_STAGES.filter((s) => applied.has(s)).length });
      if (!finished && STANDARD_STAGES.every((candidate) => applied.has(candidate))) {
        finished = true;
        emit({ phase: "ready" });
      }
    } catch (error) {
      if (disposed) return;
      emit({
        phase: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let queue: Promise<void> = Promise.resolve();

  function onMessage(message: RealtimeMessage): void {
    if (assetHash === null) return;
    if (message.t === "analysis.partial" && message.assetHash === assetHash) {
      // Serialise: two stages can finish within one tick, and ingest has to be
      // applied before anything that needs the source.
      queue = queue.then(() => handlePartial(message));
    } else if (message.t === "analysis.failed" && message.assetHash === assetHash) {
      // An optional stage (describe) failing must not turn a playable song into a failure.
      const failed = asAnalysisStage(message.stage);
      if (failed !== undefined && OPTIONAL_STAGES.includes(failed)) return;
      emit({ phase: "failed", message: message.message, stage: message.stage });
    }
  }

  const stopListening = deps.realtime.on(onMessage);

  return {
    async start(file) {
      if (started) throw new Error("this upload flow has already started");
      started = true;
      filename = file.name;
      title = titleFromFilename(file.name);
      try {
        emit({ phase: "hashing" });
        const bytes = await file.bytes();
        const hash = await hashBytes(bytes);
        assetHash = hash;
        await deps.platform.blobCache.put(bytes);
        emit({ phase: "checking", assetHash: hash });

        const mime = guessMime(file.name);
        const presign = await deps.api.presign({ hash, bytes: bytes.byteLength, mime });
        if (!presign.exists) {
          emit({ phase: "uploading" });
          const put = await doFetch(presign.uploadUrl, {
            method: "PUT",
            headers: presign.headers,
            body: bytes as unknown as BodyInit,
          });
          if (!put.ok) throw new Error(`the upload failed (${put.status})`);
        }
        // Complete even when the object already existed: this is what records
        // this user's ownership (`user_assets`), which upload dedupe does not (05 §2).
        await deps.api.complete(hash, mime);

        // Submit first, subscribe second. The server grants this user the outputs of stages another
        // user's upload of the same bytes already finished while it handles the POST, and the
        // download of a finished stage is ownership-checked: a `sub` before the POST would replay
        // those stages too early (404). A stage finishing between the POST and the `sub` is not
        // lost, the `sub` replays every finished stage (05 §3) and so does `getAnalyses`.
        emit({ phase: "queueing" });
        await deps.api.postAnalyses(hash, "standard");
        await replayFromServer(hash);
        return { projectId: await waitForProject(), assetHash: hash };
      } catch (error) {
        emit({
          phase: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
    state: () => state,
    async resume({ assetHash: hash, view: initialView }) {
      if (started) throw new Error("this upload flow has already started");
      started = true;
      const doc = deps.songStore.store.getState().doc;
      const source = doc?.sources[0];
      if (doc === null || source === undefined) throw new Error("resume needs a loaded project");
      assetHash = hash;
      projectId = doc.id;
      sourceId = source.id;
      title = doc.meta.title;
      ingested = true;
      view = (initialView ?? {}) as StageArtifacts;
      for (const stage of Object.keys(doc.analyses[source.id]?.blobs ?? {})) applied.add(stage);
      const done = STANDARD_STAGES.filter((candidate) => applied.has(candidate)).length;
      emit({ phase: "analysing", assetHash: hash, projectId: doc.id, stagesDone: done });
      if (done === STANDARD_STAGES.length) {
        finished = true;
        emit({ phase: "ready" });
        return;
      }
      await replayFromServer(hash);
    },
    dispose() {
      disposed = true;
      stopListening();
      if (assetHash !== null) deps.realtime.unsubscribe([`asset:${assetHash}`]);
    },
  };

  /**
   * The server also replays finished stages on `sub`; this covers a stage that finished before
   * the socket opened. Replay in DAG order so ingest creates the source before the rest.
   */
  async function replayFromServer(hash: string): Promise<void> {
    deps.realtime.subscribe([`asset:${hash}`]);
    const snapshot = await deps.api.getAnalyses(hash);
    const order = new Map(STANDARD_STAGES.map((stage, index) => [stage, index]));
    const stages = [...snapshot.stages].sort(
      (a, b) =>
        (order.get(a.stage as AnalysisStage) ?? 99) - (order.get(b.stage as AnalysisStage) ?? 99),
    );
    for (const stage of stages) {
      queue = queue.then(() => replayDone(stage));
    }
    await queue;
  }

  async function replayDone(stage: AnalysisStageStatus): Promise<void> {
    if (stage.status === "done" && stage.blob !== undefined) {
      await handlePartial({ stage: stage.stage, blob: stage.blob });
    }
  }

  /** `start` resolves with the project, which ingest creates; the rest runs on. */
  async function waitForProject(): Promise<string> {
    for (;;) {
      if (projectId !== null) return projectId;
      if (state.phase === "failed") {
        throw new Error(state.message ?? "the analysis failed before ingest");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

/** The AssetIndex metadata for the stems and residual a `separation` op introduces. */
function stemAssetMetas(separation: SeparationResult, songStore: SongStore): AssetMeta[] {
  const doc = songStore.store.getState().doc;
  const durationSamples = doc?.sources[0]?.durationSamples ?? 1;
  return [separation.residual, ...separation.stems.map((stem) => stem.asset)].map((hash) => ({
    hash,
    mime: "audio/flac",
    bytes: 0,
    sampleRate: 48_000,
    channels: 2,
    durationSamples,
  }));
}
