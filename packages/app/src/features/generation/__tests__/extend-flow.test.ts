/**
 * The extend flow end to end (`specs/09-generation.md` §4.2, §5; `specs/07-song-canvas.md` §6).
 *
 * A fake API, a fake socket and a fake context render: the test drives one job from context render
 * to streaming candidates, the accept path (analysis + HQ), discard, job errors and the quality
 * warning. The document still goes through the real `bragi-model` wasm and the history store, so
 * the candidate snapshots are the ones the app would commit.
 */
import { readdirSync, readFileSync } from "node:fs";

import type {
  ApiClient,
  GenerateExtendSubmit,
  JobAccepted,
  RealtimeClient,
  RealtimeMessage,
  RealtimeStatus,
} from "@bragi/api-client";
import { ApiClientError } from "@bragi/api-client";
import type { EngineHost, EngineState } from "@bragi/platform";
import { parseMigrations } from "@bragi/platform";
import { createMemoryPlatform } from "@bragi/platform/testing";
import type { GenerateExtendResult, TagResult } from "@bragi/schemas";
import { describe, expect, it, vi } from "vitest";

import { sha256Hex } from "../../analysis/api/hash.js";
import { type Audition, createAudition } from "../../audition/state/audition.js";
import { createHistory, type History } from "../../history/state/history.js";
import { loadTestModel } from "../../song/__tests__/fixtures.js";
import { buildDemoProject, fakeAssetHash, SHORT_DEMO } from "../../song/api/demo-song.js";
import { createEngineController } from "../../song/state/engine-controller.js";
import { createSongStore, type SongStore } from "../../song/state/song-store.js";
import { createExtendFlow, type ExtendFlow, type ExtendState } from "../state/extend-flow.js";

const MIGRATIONS_DIR = new URL("../../../../../schemas/sqlite/migrations/", import.meta.url);
const migrations = parseMigrations(
  Object.fromEntries(
    readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => [name, readFileSync(new URL(name, MIGRATIONS_DIR), "utf8")]),
  ),
);

const NOW = new Date("2026-10-21T12:00:00.000Z");
const SEED = 1234;
const CONTEXT_BYTES = new TextEncoder().encode("context-wav");

class FakeRealtime implements RealtimeClient {
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

interface SubmitCall {
  readonly body: GenerateExtendSubmit;
  readonly jobId: string;
}

interface Harness {
  readonly platform: Awaited<ReturnType<typeof createMemoryPlatform>>;
  readonly songStore: SongStore;
  readonly history: History;
  readonly flow: ExtendFlow;
  readonly audition: Audition;
  readonly realtime: FakeRealtime;
  readonly store: Map<string, Uint8Array>;
  readonly submits: SubmitCall[];
  readonly cancelled: string[];
  readonly analysed: { hash: string; profile: string }[];
  readonly announced: string[];
  readonly errors: string[];
  readonly renderContext: ReturnType<typeof vi.fn>;
  /** The section count of the song before the job. */
  readonly originalSections: number;
  /** A finished candidate's asset + blob, both in the blob map. */
  candidate(
    index: number,
    patch?: Partial<GenerateExtendResult>,
  ): Promise<{ assetHash: string; blobHash: string; result: GenerateExtendResult }>;
  partial(index: number, assetHash: string, blobHash: string, jobId?: string): void;
  progress(pct: number, etaSec?: number): void;
}

interface HarnessOptions {
  /** The first submit rejects with this error (the 402/503 paths). */
  readonly submitError?: Error;
  readonly warmup?: "warming" | "warm" | "disabled";
}

function fakeHost(): EngineHost {
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

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const platform = await createMemoryPlatform(migrations);
  const model = await loadTestModel();
  const built = buildDemoProject(SHORT_DEMO, {
    assetFor: (key) => fakeAssetHash(`extend:${key}`),
    projectId: "EXTENDFLOWTEST00000000001",
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
  const host = fakeHost();
  const controller = createEngineController({
    createEngine: async () => host,
    document: () => songStore.store.getState().doc,
    durationSec: () => 32,
  });

  const realtime = new FakeRealtime();
  const store = new Map<string, Uint8Array>();
  const submits: SubmitCall[] = [];
  const cancelled: string[] = [];
  const analysed: { hash: string; profile: string }[] = [];
  const announced: string[] = [];
  const errors: string[] = [];
  const timers: (() => void)[] = [];
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
      if (options.submitError !== undefined) throw options.submitError;
      jobCounter += 1;
      const accepted: JobAccepted = {
        jobId: `job_EXTEND0${jobCounter}`,
        status: "queued",
        createdAt: NOW.toISOString(),
        estimatedCredits: 2,
      };
      submits.push({ body, jobId: accepted.jobId });
      return accepted;
    },
    cancelJob: async (jobId) => {
      cancelled.push(jobId);
    },
    warmupGeneration: async () => ({ status: options.warmup ?? "warm" }),
  };

  let audition: Audition | null = null;
  const renderContext = vi.fn(async () => CONTEXT_BYTES);
  const flow = createExtendFlow({
    platform,
    api,
    realtime,
    songStore,
    history,
    renderContext,
    audition: {
      open: (openOptions) => audition?.openCandidates(openOptions) ?? Promise.resolve(false),
      setQueue: (status) => audition?.setQueue(status),
      isOpen: () => audition?.store.getState().group != null,
    },
    fetch: doFetch,
    hash: sha256Hex,
    seed: () => SEED,
    now: () => NOW,
    onAnnounce: (message) => announced.push(message),
    onError: (message) => errors.push(message),
    onCommit: (commit, doc) => controller.commit(commit, doc),
  });
  audition = createAudition({
    controller,
    history,
    document: () => songStore.store.getState().doc,
    source: flow.source,
    onAccept: (candidateId) => flow.accepted(candidateId),
    onDiscard: (group) => flow.discarded(group),
    onOutcome: (outcome) => {
      if (outcome?.ok) controller.commit(outcome.commit, outcome.doc);
    },
    onAnnounce: (message) => announced.push(message),
    setTimeout: (callback) => timers.push(callback),
  });

  async function candidate(
    index: number,
    patch: Partial<GenerateExtendResult> = {},
  ): Promise<{ assetHash: string; blobHash: string; result: GenerateExtendResult }> {
    const assetBytes = new TextEncoder().encode(`candidate-${index}`);
    const assetHash = await sha256Hex(assetBytes);
    store.set(assetHash, assetBytes);
    const result: GenerateExtendResult = {
      schemaVersion: 1,
      index,
      asset: assetHash,
      seed: 100 + index,
      model: "fake",
      modelVersion: "1.0.0",
      passed: true,
      qualityWarning: false,
      seamScore: 0.2,
      tempoError: 0.001,
      spliceOffsetSamples: -48_000,
      direction: "forward",
      steps: [{ step: "sanity", passed: true, skipped: false, metrics: {} }],
      ...patch,
    };
    const blobBytes = new TextEncoder().encode(JSON.stringify(result));
    const blobHash = await sha256Hex(blobBytes);
    store.set(blobHash, blobBytes);
    return { assetHash, blobHash, result };
  }

  return {
    platform,
    songStore,
    history,
    flow,
    audition,
    realtime,
    store,
    submits,
    cancelled,
    analysed,
    announced,
    errors,
    renderContext,
    originalSections: built.project.arrangement.sections.length,
    candidate,
    partial(index, assetHash, blobHash, jobId = "job_EXTEND01") {
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
    progress(pct, etaSec) {
      realtime.emit({
        t: "job.progress",
        jobId: "job_EXTEND01",
        stage: "extend",
        pct,
        ...(etaSec === undefined ? {} : { etaSec }),
      });
    },
  };
}

function state(h: Harness): ExtendState {
  return h.flow.store.getState();
}

async function startForward(h: Harness, prompt?: string): Promise<void> {
  const started = await h.flow.start({
    direction: "forward",
    bars: 8,
    ...(prompt === undefined ? {} : { prompt }),
  });
  expect(started).toBe(true);
}

describe("the extend flow", () => {
  it("renders a bar-aligned context, submits the preview job and opens the bar", async () => {
    const h = await harness();
    await startForward(h, "dreamy outro");

    expect(h.renderContext).toHaveBeenCalledTimes(1);
    const range = h.renderContext.mock.calls[0]?.[0] as { startTick: number; endTick: number };
    expect(range.startTick % 3_840).toBe(0);
    expect(range.endTick % 3_840).toBe(0);

    const submit = h.submits[0];
    expect(submit?.body.capability).toBe("generate.extend");
    expect(submit?.body.priority).toBe("interactive");
    expect(submit?.body.projectId).toBe("prj_EXTENDFLOWTEST00000000001");
    expect(submit?.body.assets.context).toMatch(/^sha256:/);
    expect(submit?.body.params).toMatchObject({
      bars: 8,
      overlapBars: 2,
      direction: "forward",
      tier: "preview",
      n: 3,
      prompt: "dreamy outro",
    });
    expect(submit?.body.params.context).toMatchObject({
      bpm: 120,
      timeSignature: [4, 4],
      sectionKind: "outro",
      seed: SEED,
    });
    expect(submit?.body.params.context.descriptors.length).toBeGreaterThan(0);

    // The bar is open before the first candidate exists, with the job's queue status.
    const group = h.audition.store.getState().group;
    expect(group?.id).toBe("job_EXTEND01");
    expect(group?.candidates).toEqual([]);
    expect(state(h).phase).toBe("generating");
    expect(h.realtime.topics()).toContain("job:job_EXTEND01");
    expect(h.announced).toContain("Generating 3 ideas…");
  });

  it("streams candidates into one audition group and accepts one with analysis and HQ", async () => {
    const h = await harness();
    await startForward(h, "dreamy outro");

    h.progress(0, 20);
    expect(h.audition.store.getState().group?.queue).toEqual({ kind: "queued", etaSec: 20 });
    h.progress(0.4, 12);
    expect(h.audition.store.getState().group?.queue).toEqual({ kind: "generating", pct: 0.4 });

    const first = await h.candidate(0);
    h.partial(0, first.assetHash, first.blobHash);
    await vi.waitFor(() => {
      expect(h.audition.store.getState().group?.candidates).toHaveLength(1);
    });
    const idea = h.audition.store.getState().group?.candidates[0];
    expect(idea?.status).toEqual({ kind: "preview" });
    expect(idea?.doc).not.toBeNull();
    // The first idea that can play starts playing (07 §6).
    expect(h.audition.store.getState().selected).toBe(1);
    expect(h.audition.store.getState().group?.queue).toBeUndefined();
    expect(state(h).candidates).toBe(1);
    expect(h.announced).toContain("Idea 1 ready");

    const second = await h.candidate(1);
    const third = await h.candidate(2);
    h.partial(1, second.assetHash, second.blobHash);
    h.partial(2, third.assetHash, third.blobHash);
    await vi.waitFor(() => {
      expect(h.audition.store.getState().group?.candidates).toHaveLength(3);
    });
    expect(h.audition.store.getState().warm).toEqual([1, 2, 3]);

    // Every candidate is one model batch on HEAD that adds a generated section.
    const candidateCommits = [...h.history.store.getState().commits.values()].filter(
      (commit) => commit.state === "candidate" && commit.candidateGroup === "job_EXTEND01",
    );
    expect(candidateCommits).toHaveLength(3);
    const snapshot = await h.history.readSnapshot(candidateCommits[0]?.id ?? "");
    expect(snapshot?.arrangement.sections).toHaveLength(h.originalSections + 1);
    expect(snapshot?.sources.some((source) => source.kind === "generated")).toBe(true);
    expect(h.songStore.store.getState().doc?.arrangement.sections).toHaveLength(h.originalSections);

    // Accept idea 2: HEAD moves, analysis is queued and the HQ re-render is submitted.
    expect(h.audition.select(2)).toBe(true);
    await h.audition.accept();
    expect(h.history.store.getState().head).toBe(candidateCommits[1]?.id);
    await vi.waitFor(() => {
      expect(h.analysed).toEqual([{ hash: second.assetHash, profile: "standard" }]);
      expect(h.submits).toHaveLength(2);
    });
    const hq = h.submits[1]?.body;
    expect(hq?.priority).toBe("background");
    expect(hq?.params).toMatchObject({ tier: "hq", n: 1, bars: 8 });
    expect(hq?.params.context.seed).toBe(101);
    expect(h.realtime.topics()).toContain(`asset:${second.assetHash}`);
    expect(h.realtime.topics()).toContain("job:job_EXTEND02");

    // An analysis stage of the accepted asset becomes one history commit.
    const tag: TagResult = {
      schemaVersion: 1,
      genres: [{ label: "synthwave", score: 0.8 }],
      moods: [],
      instruments: [],
      descriptors: [],
    };
    const tagBytes = new TextEncoder().encode(JSON.stringify(tag));
    const tagHash = await sha256Hex(tagBytes);
    h.store.set(tagHash, tagBytes);
    h.realtime.emit({
      t: "analysis.partial",
      assetHash: second.assetHash,
      stage: "tag",
      blob: tagHash,
    });
    await vi.waitFor(() => {
      expect(h.songStore.store.getState().doc?.meta.tags ?? []).toContain("synthwave");
    });

    // The HQ render arriving is announced; the document keeps the preview (documented deviation).
    const hqAssetBytes = new TextEncoder().encode("hq-candidate");
    const hqAsset = await sha256Hex(hqAssetBytes);
    h.store.set(hqAsset, hqAssetBytes);
    const hqResult = await h.candidate(0, { asset: hqAsset });
    h.partial(0, hqResult.assetHash, hqResult.blobHash, "job_EXTEND02");
    await vi.waitFor(() => {
      expect(h.announced).toContain("The HQ version is ready");
    });
  });

  it("cancels the job when the ideas are discarded", async () => {
    const h = await harness();
    await startForward(h);
    const first = await h.candidate(0);
    h.partial(0, first.assetHash, first.blobHash);
    await vi.waitFor(() => {
      expect(h.audition.store.getState().group?.candidates).toHaveLength(1);
    });

    await h.audition.discard();
    expect(h.cancelled).toEqual(["job_EXTEND01"]);
    expect(state(h).phase).toBe("cancelled");
    expect(h.audition.store.getState().group).toBeNull();
  });

  it("shows a plain message for credits and busy errors", async () => {
    const credits = await harness({
      submitError: new ApiClientError("INSUFFICIENT_CREDITS", "no credits", 402),
    });
    await credits.flow.start({ direction: "forward", bars: 4 });
    expect(state(credits).phase).toBe("failed");
    expect(state(credits).message).toBe("You do not have enough credits for this one");
    expect(credits.errors).toEqual(["You do not have enough credits for this one"]);
    expect(credits.audition.store.getState().group).toBeNull();

    const busy = await harness({
      submitError: new ApiClientError("GENERATION_BUSY", "budget", 503),
    });
    await busy.flow.start({ direction: "forward", bars: 4 });
    expect(state(busy).message).toBe("The generator is busy right now. Try again in a minute");
  });

  it("flags a candidate whose gates warned (09 §6)", async () => {
    const h = await harness();
    await startForward(h);
    const warned = await h.candidate(0, { passed: false, qualityWarning: true });
    h.partial(0, warned.assetHash, warned.blobHash);
    await vi.waitFor(() => {
      expect(h.audition.store.getState().group?.candidates).toHaveLength(1);
    });
    const candidate = h.audition.store.getState().group?.candidates[0];
    expect(candidate?.warning).toBe("This one might not blend perfectly");
  });

  it("warms the pool once and reports a disabled server", async () => {
    const h = await harness();
    await expect(h.flow.warmup()).resolves.toBe("warm");
    await expect(h.flow.warmup()).resolves.toBe("warm");

    const disabled = await harness({ warmup: "disabled" });
    await expect(disabled.flow.warmup()).resolves.toBe("disabled");
  });
});
