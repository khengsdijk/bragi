/**
 * The fixture the generation-flow tests share: a real `bragi-model` document and history, a fake
 * API, a fake socket, a fake engine render and a byte store.
 *
 * No audio is committed: candidates are tiny byte strings in the store. Every document change still
 * goes through the real model and the history store, so a candidate's snapshot is the one the app
 * would write. Each test wires its own flow and Audition bar from these pieces.
 */
import { readdirSync, readFileSync } from "node:fs";

import type {
  ApiClient,
  JobAccepted,
  RealtimeClient,
  RealtimeMessage,
  RealtimeStatus,
} from "@bragi/api-client";
import type { EngineHost, EngineState } from "@bragi/platform";
import { parseMigrations } from "@bragi/platform";
import { createMemoryPlatform } from "@bragi/platform/testing";
import type { PlanExecuteRequest, PlanExecuteResponse } from "@bragi/schemas";
import { vi } from "vitest";

import { sha256Hex } from "../../analysis/api/hash.js";
import { createHistory, type History } from "../../history/state/history.js";
import { loadTestModel } from "../../song/__tests__/fixtures.js";
import { buildDemoProject, fakeAssetHash, SHORT_DEMO } from "../../song/api/demo-song.js";
import { createEngineController } from "../../song/state/engine-controller.js";
import { createSongStore, type SongStore } from "../../song/state/song-store.js";

const MIGRATIONS_DIR = new URL("../../../../../schemas/sqlite/migrations/", import.meta.url);
const migrations = parseMigrations(
  Object.fromEntries(
    readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => [name, readFileSync(new URL(name, MIGRATIONS_DIR), "utf8")]),
  ),
);

export const NOW = new Date("2026-10-21T12:00:00.000Z");
export const SEED = 1234;
/** The demo song is 16 bars of 4/4 at 120 BPM: one bar is 3 840 ticks and 2 s. */
export const TICKS_PER_BAR = 3_840;
export const BAR_SAMPLES = 96_000;
export const CONTEXT_BYTES = new TextEncoder().encode("context-wav");

export class FakeRealtime implements RealtimeClient {
  private readonly handlers = new Set<(message: RealtimeMessage) => void>();
  private readonly wanted = new Set<string>();

  on(handler: (message: RealtimeMessage) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  subscribe(topics: readonly string[]): void {
    for (const topic of topics) this.wanted.add(topic);
  }
  unsubscribe(topics: readonly string[]): void {
    for (const topic of topics) this.wanted.delete(topic);
  }
  topics(): readonly string[] {
    return [...this.wanted];
  }
  status(): RealtimeStatus {
    return "open";
  }
  close(): void {}
  emit(message: RealtimeMessage): void {
    for (const handler of this.handlers) handler(message);
  }
}

export interface SubmitCall {
  readonly body: {
    capability: string;
    priority: string;
    projectId: string;
    assets: Readonly<Record<string, string>>;
    params: unknown;
  };
  readonly jobId: string;
}

export interface SongFixture {
  readonly platform: Awaited<ReturnType<typeof createMemoryPlatform>>;
  readonly songStore: SongStore;
  readonly history: History;
  readonly controller: ReturnType<typeof createEngineController>;
}

/** Opens the short demo song with a history store and a fake engine. */
export async function openSong(): Promise<SongFixture> {
  const platform = await createMemoryPlatform(migrations);
  const model = await loadTestModel();
  const built = buildDemoProject(SHORT_DEMO, {
    assetFor: (key) => fakeAssetHash(`generation-test:${key}`),
    projectId: "GENERATIONFLOWTEST00000001",
  });
  await platform.localDb.run(
    "INSERT OR IGNORE INTO projects (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
    [built.project.id, built.project.meta.title, built.project.meta.createdAt, NOW.toISOString()],
  );
  const songStore = createSongStore(model);
  songStore.load(built.project, built.assets);
  const history = createHistory({
    platform,
    songStore,
    model,
    projectId: built.project.id,
    now: () => NOW,
  });
  await history.load();
  const controller = createEngineController({
    createEngine: async () => fakeHost(),
    document: () => songStore.store.getState().doc,
    durationSec: () => 32,
  });
  return { platform, songStore, history, controller };
}

export function fakeHost(): EngineHost {
  return {
    init: vi.fn(async () => {}),
    loadDocument: vi.fn(async () => {}),
    applyDelta: vi.fn(),
    setPreview: vi.fn(),
    transport: vi.fn(),
    warm: vi.fn(async (_slot: number, _doc: unknown) => {}),
    release: vi.fn((_slot: number) => {}),
    audition: vi.fn((_slot: number) => {}),
    render: vi.fn(),
    peaks: vi.fn(),
    spectrogram: vi.fn(),
    onState: vi.fn((_cb: (state: EngineState) => void) => () => {}),
    onEvent: vi.fn(() => () => {}),
    dispose: vi.fn(async () => {}),
  };
}

export interface FakeApi {
  readonly api: ApiClient;
  readonly realtime: FakeRealtime;
  /** Bytes of the uploaded contexts and candidate assets, by hash. */
  readonly store: Map<string, Uint8Array>;
  readonly submits: SubmitCall[];
  readonly executes: { planId: string; request: PlanExecuteRequest }[];
  readonly cancelled: string[];
  readonly analysed: { hash: string; profile: string }[];
  /** The fake network: `blob:<hash>` resolves from the store and `blob:upload` accepts a PUT. */
  readonly fetch: typeof globalThis.fetch;
  put(bytes: string): Promise<string>;
  partial(jobId: string, index: number, assetHash: string, blobHash: string): void;
  progress(jobId: string, pct: number, etaSec?: number): void;
}

export interface FakeApiOptions {
  readonly execute?: (
    planId: string,
    request: PlanExecuteRequest,
  ) => PlanExecuteResponse | Promise<PlanExecuteResponse>;
}

/** A fake API, socket and blob store; each submitted job gets `job_GEN01`, … in order. */
export function createFakeApi(options: FakeApiOptions = {}): FakeApi {
  const realtime = new FakeRealtime();
  const store = new Map<string, Uint8Array>();
  const submits: SubmitCall[] = [];
  const executes: { planId: string; request: PlanExecuteRequest }[] = [];
  const cancelled: string[] = [];
  const analysed: { hash: string; profile: string }[] = [];
  let jobCounter = 0;
  const doFetch = (async (url: string | URL) => {
    const key = String(url).replace(/^blob:/, "");
    if (key === "upload") return new Response("", { status: 200 });
    const bytes = store.get(key);
    return bytes === undefined
      ? new Response("", { status: 404 })
      : new Response(bytes as unknown as BodyInit, { status: 200 });
  }) as unknown as typeof globalThis.fetch;

  const api: ApiClient = {
    baseUrl: "",
    meta: async () => ({ apiVersion: "1", minClientVersion: "1", features: {} }),
    getAuthMode: async () => ({ mode: "single-user", user: null }),
    signInWithEmail: async () => {},
    presign: async () => ({ exists: false, uploadUrl: "blob:upload", headers: {}, expiresIn: 900 }),
    complete: async (hash) => ({ hash, bytes: 0, mime: null }),
    assetUrl: async (hash) => ({ url: `blob:${hash}`, expiresIn: 60 }),
    postAnalyses: async (hash, profile) => {
      analysed.push({ hash, profile });
      return { assetHash: hash, profile, stages: [] };
    },
    getAnalyses: async (hash) => ({ assetHash: hash, stages: [] }),
    library: async () => ({ items: [], nextCursor: null }),
    importLibrary: async () => ({ items: [], enqueuedStages: [] }),
    submitJob: async (body) => {
      jobCounter += 1;
      const accepted: JobAccepted = {
        jobId: `job_GEN${String(jobCounter).padStart(2, "0")}`,
        status: "queued",
        createdAt: NOW.toISOString(),
        estimatedCredits: 2,
      };
      submits.push({ body: body as SubmitCall["body"], jobId: accepted.jobId });
      return accepted;
    },
    cancelJob: async (jobId) => {
      cancelled.push(jobId);
    },
    warmupGeneration: async () => ({ status: "warm" }),
    plan: async () => {
      throw new Error("this flow never plans");
    },
    executePlan: async (planId, request) => {
      executes.push({ planId, request });
      return (await options.execute?.(planId, request)) ?? { jobs: [] };
    },
  };

  async function put(bytes: string): Promise<string> {
    const data = new TextEncoder().encode(bytes);
    const hash = await sha256Hex(data);
    store.set(hash, data);
    return hash;
  }

  return {
    api,
    realtime,
    store,
    submits,
    executes,
    cancelled,
    analysed,
    fetch: doFetch,
    put,
    partial(jobId, index, assetHash, blobHash) {
      realtime.emit({
        t: "job.partial",
        jobId,
        index,
        outputs: {
          assets: { [`candidate_${index}`]: assetHash },
          blobs: { [`candidate_${index}`]: blobHash },
        },
      });
    },
    progress(jobId, pct, etaSec) {
      realtime.emit({
        t: "job.progress",
        jobId,
        stage: "generate",
        pct,
        ...(etaSec === undefined ? {} : { etaSec }),
      });
    },
  };
}

/** The dependencies every generation flow needs, minus its audition binding. */
export function flowDeps(
  song: SongFixture,
  fake: FakeApi,
  overrides: {
    readonly renderContext: (range: unknown) => Promise<Uint8Array>;
    readonly audition: {
      open: (
        options: Parameters<
          import("../../audition/state/audition.js").Audition["openCandidates"]
        >[0],
      ) => Promise<boolean>;
      setQueue: (
        status: Parameters<import("../../audition/state/audition.js").Audition["setQueue"]>[0],
      ) => void;
      isOpen: () => boolean;
    };
    readonly onAnnounce: (message: string) => void;
    readonly onError: (message: string) => void;
    readonly onCommit: (
      commit: Parameters<SongFixture["controller"]["commit"]>[0],
      doc: Parameters<SongFixture["controller"]["commit"]>[1],
    ) => void;
  },
) {
  return {
    platform: song.platform,
    api: fake.api,
    realtime: fake.realtime,
    songStore: song.songStore,
    history: song.history,
    renderContext: overrides.renderContext,
    audition: overrides.audition,
    fetch: fake.fetch,
    hash: sha256Hex,
    seed: () => SEED,
    now: () => NOW,
    onAnnounce: overrides.onAnnounce,
    onError: overrides.onError,
    onCommit: overrides.onCommit,
  };
}
