import { readdirSync, readFileSync } from "node:fs";

import type { ApiClient, RealtimeClient, RealtimeMessage, RealtimeStatus } from "@bragi/api-client";
import { type Platform, parseMigrations } from "@bragi/platform";
import { createMemoryPlatform } from "@bragi/platform/testing";
import { describe, expect, it } from "vitest";

import {
  getDeviceId,
  headRef,
  listCommits,
  readCommitSnapshot,
  setRef,
} from "../../history/api/history-repo.js";
import { getProjectSnapshot, listLibraryItems } from "../../library/api/library-repo.js";
import { loadTestModel } from "../../song/__tests__/fixtures.js";
import { createSongStore, type SongStore } from "../../song/state/song-store.js";
import { sha256Hex } from "../api/hash.js";
import { createUploadFlow, guessMime, titleFromFilename, type UploadState } from "../state/flow.js";

const MIGRATIONS_DIR = new URL("../../../../../schemas/sqlite/migrations/", import.meta.url);

async function memoryPlatform(): Promise<Platform> {
  const files = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql"));
  const migrations = parseMigrations(
    Object.fromEntries(
      files.map((name) => [name, readFileSync(new URL(name, MIGRATIONS_DIR), "utf8")]),
    ),
  );
  return createMemoryPlatform(migrations);
}

interface Fixture {
  readonly hash: string;
  readonly json: unknown;
}

/** Stores JSON bytes in the fake object store and returns their content address. */
async function register(store: Map<string, Uint8Array>, json: unknown): Promise<Fixture> {
  const bytes = new TextEncoder().encode(JSON.stringify(json));
  const hash = await sha256Hex(bytes);
  store.set(hash, bytes);
  return { hash, json };
}

async function registerAudio(store: Map<string, Uint8Array>, seed: string): Promise<string> {
  const bytes = new TextEncoder().encode(`audio:${seed}`);
  const hash = await sha256Hex(bytes);
  store.set(hash, bytes);
  return hash;
}

class FakeRealtime implements RealtimeClient {
  private readonly handlers = new Set<(message: RealtimeMessage) => void>();
  private readonly wanted = new Set<string>();
  statusValue: RealtimeStatus = "open";

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
    return this.statusValue;
  }
  close(): void {}
  emit(message: RealtimeMessage): void {
    for (const handler of this.handlers) handler(message);
  }
}

interface Harness {
  readonly flow: ReturnType<typeof createUploadFlow>;
  readonly platform: Platform;
  readonly songStore: SongStore;
  readonly realtime: FakeRealtime;
  readonly store: Map<string, Uint8Array>;
  readonly states: UploadState[];
  readonly views: Record<string, unknown>[];
  readonly projects: string[];
  /** A realtime partial for the asset the last `postAnalyses` named. */
  readonly partial: (stage: string, fixture: Fixture) => void;
  readonly postAnalysesEmit: (stage: string, fixture: Fixture) => void;
}

async function harness(
  onCommit?: (commit: { batch: { label: string } | null }, platform: Platform) => void,
): Promise<Harness> {
  const platform = await memoryPlatform();
  const store = new Map<string, Uint8Array>();
  const realtime = new FakeRealtime();
  const songStore = createSongStore(await loadTestModel());
  const states: UploadState[] = [];
  const views: Record<string, unknown>[] = [];
  const projects: string[] = [];
  let assetHash = "";

  const doFetch = (async (url: string | URL) => {
    const key = String(url);
    if (key === "blob:upload") return new Response("", { status: 200 });
    const bytes = store.get(key.replace(/^blob:/, ""));
    return bytes === undefined
      ? new Response("", { status: 404 })
      : new Response(bytes as unknown as BodyInit, { status: 200 });
  }) as unknown as typeof globalThis.fetch;

  let onPost: (() => void) | undefined;
  const api: ApiClient = {
    baseUrl: "",
    meta: async () => ({ apiVersion: "1", minClientVersion: "1", features: {} }),
    getAuthMode: async () => ({ mode: "multi-user", user: null }),
    signInWithEmail: async () => {},
    presign: async () => ({ exists: false, uploadUrl: "blob:upload", headers: {}, expiresIn: 900 }),
    complete: async (hash) => ({ hash, bytes: 0, mime: null }),
    assetUrl: async (hash) => ({ url: `blob:${hash}`, expiresIn: 3600 }),
    postAnalyses: async (hash) => {
      assetHash = hash;
      onPost?.();
      onPost = undefined;
      return { assetHash: hash, profile: "standard", stages: [] };
    },
    getAnalyses: async (hash) => ({ assetHash: hash, stages: [] }),
    library: async () => ({ items: [], nextCursor: null }),
    importLibrary: async () => ({ items: [], enqueuedStages: [] }),
  };

  const flow = createUploadFlow({
    platform,
    api,
    realtime,
    songStore,
    fetch: doFetch,
    onState: (state) => states.push(state),
    onAnalysis: (data) => views.push(data as Record<string, unknown>),
    onProject: (projectId) => projects.push(projectId),
    onCommit: (commit) => onCommit?.(commit, platform),
    now: () => new Date("2026-10-19T12:00:00Z"),
  });

  return {
    flow,
    platform,
    songStore,
    realtime,
    store,
    states,
    views,
    projects,
    partial: (stage, fixture) => {
      realtime.emit({ t: "analysis.partial", assetHash, stage, blob: fixture.hash });
    },
    postAnalysesEmit: (stage, fixture) => {
      onPost = () => {
        queueMicrotask(() =>
          realtime.emit({ t: "analysis.partial", assetHash, stage, blob: fixture.hash }),
        );
      };
    },
  };
}

/** Waits for the flow's internal (async, multi-await) queue to settle. */
async function drain(): Promise<void> {
  for (let index = 0; index < 20; index += 1)
    await new Promise((resolve) => setTimeout(resolve, 2));
}

describe("guessMime / titleFromFilename", () => {
  it("guesses a content type and a title", () => {
    expect(guessMime("song.FLAC")).toBe("audio/flac");
    expect(guessMime("mystery")).toBe("application/octet-stream");
    expect(titleFromFilename("My Song.mp3")).toBe("My Song");
    expect(titleFromFilename(".hidden")).toBe(".hidden");
  });
});

describe("the upload -> live-analysis flow", () => {
  it("hashes, uploads, queues, restores the working asset and creates the project on ingest", async () => {
    const h = await harness();
    const workingAsset = await registerAudio(h.store, "working");
    const ingest = await register(h.store, {
      schemaVersion: 1,
      workingAsset,
      durationSec: 240,
      channelsOriginal: 2,
      sampleRateOriginal: 44100,
      codec: "mp3",
      fingerprint: "fp",
    });
    h.postAnalysesEmit("ingest", ingest);

    const bytes = new TextEncoder().encode("the uploaded file");
    const result = await h.flow.start({
      name: "My Song.mp3",
      bytes: async () => bytes,
    });

    expect(result.assetHash).toBe(await sha256Hex(bytes));
    expect(result.projectId).toMatch(/^prj_/);
    expect(h.projects).toEqual([result.projectId]);
    expect(h.realtime.topics()).toContain(`asset:${result.assetHash}`);

    // The document exists with the source, the full-mix track and the Song section.
    const doc = await getProjectSnapshot(h.platform, result.projectId);
    expect(doc?.sources).toHaveLength(1);
    expect(doc?.sources[0]?.workingAsset).toBe(workingAsset);
    expect(doc?.tracks.map((track) => track.role)).toContain("full_mix");
    expect(doc?.arrangement.sections).toHaveLength(1);
    expect(doc?.analyses[doc.sources[0]?.id ?? ""]?.status.ingest).toBe("done");

    // The working asset was downloaded into the BlobCache and its library row exists.
    expect(await h.platform.blobCache.has(workingAsset as `sha256:${string}`)).toBe(true);
    const library = await listLibraryItems(h.platform.localDb);
    expect(library).toHaveLength(1);
    expect(library[0]?.filename).toBe("My Song.mp3");

    // The state went through the phases to "analysing".
    const phases = h.states.map((state) => state.phase);
    expect(phases).toContain("hashing");
    expect(phases).toContain("uploading");
    expect(phases).toContain("queueing");
    expect(h.flow.state().assetHash).toBe(result.assetHash);
  });

  it("merges every standard stage through analysis.apply and reaches ready", async () => {
    // The engine resyncs from the document on every commit and reads the audio from the cache:
    // the stems must already be there when the separation commit is announced.
    const stemsAtCommit: boolean[] = [];
    let stemHashes: string[] = [];
    const h = await harness((commit, platform) => {
      if (commit.batch?.label !== "Analysis: separation") return;
      void Promise.all(
        stemHashes.map((hash) => platform.blobCache.has(hash as `sha256:${string}`)),
      ).then((has) => stemsAtCommit.push(...has));
    });
    const workingAsset = await registerAudio(h.store, "working");
    const ingest = await register(h.store, {
      schemaVersion: 1,
      workingAsset,
      durationSec: 60,
      channelsOriginal: 2,
      sampleRateOriginal: 48000,
      codec: "wav",
      fingerprint: "fp",
    });
    const vocals = await registerAudio(h.store, "vocals");
    const drums = await registerAudio(h.store, "drums");
    const residual = await registerAudio(h.store, "residual");

    stemHashes = [vocals, drums, residual];
    const fixtures: Record<string, Fixture> = {
      ingest,
      rhythm: await register(h.store, {
        schemaVersion: 1,
        bpm: 120,
        beats: [0, 0.5, 1],
        downbeats: [0],
        tempoCurve: [{ beat: 0, bpm: 120 }],
        timeSignature: { numerator: 4, denominator: 4 },
        confidence: 0.9,
        isTempoStable: true,
      }),
      structure: await register(h.store, {
        schemaVersion: 1,
        sections: [{ startSec: 0, endSec: 30, kind: "verse", confidence: 0.8 }],
      }),
      separation: await register(h.store, {
        schemaVersion: 1,
        model: "htdemucs_6s-1",
        stems: [
          { role: "vocals", asset: vocals, rmsDb: -18.2 },
          { role: "drums", asset: drums, rmsDb: -12.1 },
        ],
        residual,
      }),
      loudness_energy: await register(h.store, {
        schemaVersion: 1,
        hopSec: 0.5,
        lufsIntegrated: -8.4,
        lra: 6.2,
        truePeakDb: -0.3,
        shortTermLufs: [-9.1, -8.7],
        energy: [0.31, 0.44],
      }),
      harmony: await register(h.store, {
        schemaVersion: 1,
        key: { tonic: "A", mode: "minor", confidence: 0.8 },
        chords: [
          { startSec: 0, endSec: 2, symbol: "Am", root: "A", quality: "min", confidence: 0.7 },
        ],
      }),
      stem_activity: await register(h.store, {
        schemaVersion: 1,
        stems: [
          {
            role: "vocals",
            active: [{ startSec: 0, endSec: 10 }],
            presence: [{ index: 0, presence: 0.8 }],
          },
        ],
      }),
      tag: await register(h.store, {
        schemaVersion: 1,
        genres: [{ label: "pop", score: 0.7 }],
        moods: [{ label: "warm", score: 0.6 }],
        instruments: [],
        descriptors: [],
      }),
      embed_full: await register(h.store, { schemaVersion: 1, model: "x", vectors: [] }),
      section_embed: await register(h.store, { schemaVersion: 1, model: "x", vectors: [] }),
      stem_embed: await register(h.store, { schemaVersion: 1, model: "x", vectors: [] }),
    };
    h.postAnalysesEmit("ingest", fixtures.ingest as Fixture);

    const result = await h.flow.start({
      name: "song.flac",
      bytes: async () => new Uint8Array([1, 2, 3]),
    });

    for (const stage of [
      "rhythm",
      "loudness_energy",
      "separation",
      "structure",
      "harmony",
      "stem_activity",
      "embed_full",
      "tag",
      "section_embed",
      "stem_embed",
    ]) {
      h.partial(stage, fixtures[stage] as Fixture);
      await drain();
    }

    const doc = await getProjectSnapshot(h.platform, result.projectId);
    const roles = doc?.tracks.map((track) => track.role) ?? [];
    expect(roles).toContain("vocals");
    expect(roles).toContain("drums");
    expect(doc?.analyses[doc.sources[0]?.id ?? ""]?.status.separation).toBe("done");
    expect(doc?.meta.tags).toContain("pop");

    await drain();
    expect(stemsAtCommit).toEqual([true, true, true]);
    // Stems were downloaded for soloing.
    for (const hash of [vocals, drums, residual]) {
      expect(await h.platform.blobCache.has(hash as `sha256:${string}`)).toBe(true);
    }

    // The canvas view got the energy curve, the chords and the ribbons.
    const view = h.views.at(-1) ?? {};
    expect(view.energy).toBeDefined();
    expect(view.chords).toBeDefined();
    expect(view.ribbons).toBeDefined();
    expect(h.flow.state().phase).toBe("ready");
  });

  it("reports analysis.failed without losing the partial document", async () => {
    const h = await harness();
    const workingAsset = await registerAudio(h.store, "working");
    const ingest = await register(h.store, {
      schemaVersion: 1,
      workingAsset,
      durationSec: 30,
      channelsOriginal: 1,
      sampleRateOriginal: 48000,
      codec: "wav",
      fingerprint: "fp",
    });
    h.postAnalysesEmit("ingest", ingest);
    const result = await h.flow.start({ name: "song.wav", bytes: async () => new Uint8Array([9]) });

    h.realtime.emit({
      t: "analysis.failed",
      assetHash: result.assetHash,
      stage: "separation",
      code: "MODEL_ERROR",
      message: "out of memory",
      retryable: false,
    });

    expect(h.flow.state().phase).toBe("failed");
    expect(h.flow.state().message).toBe("out of memory");
    expect(await getProjectSnapshot(h.platform, result.projectId)).not.toBeNull();
  });

  it("ignores a failed optional stage (describe) and a disposed flow", async () => {
    const h = await harness();
    const workingAsset = await registerAudio(h.store, "working");
    const ingest = await register(h.store, {
      schemaVersion: 1,
      workingAsset,
      durationSec: 30,
      channelsOriginal: 1,
      sampleRateOriginal: 48000,
      codec: "wav",
      fingerprint: "fp",
    });
    h.postAnalysesEmit("ingest", ingest);
    const result = await h.flow.start({ name: "song.wav", bytes: async () => new Uint8Array([8]) });
    h.realtime.emit({
      t: "analysis.failed",
      assetHash: result.assetHash,
      stage: "describe",
      code: "MODEL_ERROR",
      message: "OPENROUTER_API_KEY is not set",
      retryable: false,
    });
    expect(h.flow.state().phase).not.toBe("failed");

    h.flow.dispose();
    const rhythm = await register(h.store, {
      schemaVersion: 1,
      bpm: 100,
      beats: [0, 0.6],
      downbeats: [0],
      tempoCurve: [{ beat: 0, bpm: 100 }],
      timeSignature: { numerator: 4, denominator: 4 },
      confidence: 0.9,
      isTempoStable: true,
    });
    h.partial("rhythm", rhythm);
    await drain();
    const doc = await getProjectSnapshot(h.platform, result.projectId);
    expect(doc?.analyses[doc.sources[0]?.id ?? ""]?.blobs.rhythm).toBeUndefined();
  });

  it("records the ingest as a root commit and one commit per stage, all system", async () => {
    const h = await harness();
    const workingAsset = await registerAudio(h.store, "working");
    const ingest = await register(h.store, {
      schemaVersion: 1,
      workingAsset,
      durationSec: 30,
      channelsOriginal: 1,
      sampleRateOriginal: 48000,
      codec: "wav",
      fingerprint: "fp",
    });
    const rhythm = await register(h.store, {
      schemaVersion: 1,
      bpm: 120,
      beats: [0, 0.5],
      downbeats: [0],
      tempoCurve: [{ beat: 0, bpm: 120 }],
      timeSignature: { numerator: 4, denominator: 4 },
      confidence: 0.9,
      isTempoStable: true,
    });
    const tag = await register(h.store, {
      schemaVersion: 1,
      genres: [],
      moods: [],
      instruments: [],
      descriptors: [],
    });
    h.postAnalysesEmit("ingest", ingest);
    const result = await h.flow.start({ name: "song.wav", bytes: async () => new Uint8Array([6]) });

    h.partial("rhythm", rhythm);
    await drain();
    h.partial("tag", tag);
    await drain();

    const commits = await listCommits(h.platform.localDb, result.projectId);
    expect(commits.map((commit) => commit.label)).toEqual([
      "Analysis: ingest",
      "Analysis: rhythm",
      "Analysis: tag",
    ]);
    expect(commits[0]?.parent).toBeNull();
    expect(commits[1]?.parent).toBe(commits[0]?.id);
    expect(commits[2]?.parent).toBe(commits[1]?.id);
    expect(commits.every((commit) => commit.authorKind === "system")).toBe(true);

    // The project row still opens the newest document.
    const snapshot = await getProjectSnapshot(h.platform, result.projectId);
    expect(snapshot?.meta.tags).toEqual([]);
  });

  it("resumes a stored project: skips merged stages, merges the rest and reports commits (Q82)", async () => {
    const h = await harness();
    const workingAsset = await registerAudio(h.store, "working");
    const ingest = await register(h.store, {
      schemaVersion: 1,
      workingAsset,
      durationSec: 30,
      channelsOriginal: 1,
      sampleRateOriginal: 48000,
      codec: "wav",
      fingerprint: "fp",
    });
    h.postAnalysesEmit("ingest", ingest);
    const result = await h.flow.start({ name: "song.wav", bytes: async () => new Uint8Array([7]) });
    h.flow.dispose();

    const snapshot = await getProjectSnapshot(h.platform, result.projectId);
    if (snapshot === null) throw new Error("no snapshot");
    const rhythm = await register(h.store, {
      schemaVersion: 1,
      bpm: 90,
      beats: [0, 0.66],
      downbeats: [0],
      tempoCurve: [{ beat: 0, bpm: 90 }],
      timeSignature: { numerator: 4, denominator: 4 },
      confidence: 0.9,
      isTempoStable: true,
    });
    const resumedStore = createSongStore(await loadTestModel());
    resumedStore.load(snapshot, [
      {
        hash: workingAsset,
        mime: "audio/flac",
        bytes: 0,
        sampleRate: 48000,
        channels: 2,
        durationSamples: 30 * 48000,
      },
    ]);
    const realtime = new FakeRealtime();
    const commits: string[] = [];
    const flow = createUploadFlow({
      platform: h.platform,
      api: {
        baseUrl: "",
        meta: async () => ({ apiVersion: "1", minClientVersion: "1", features: {} }),
        getAuthMode: async () => ({ mode: "multi-user", user: null }),
        signInWithEmail: async () => {},
        presign: async () => {
          throw new Error("resume must not upload");
        },
        complete: async () => {
          throw new Error("resume must not upload");
        },
        assetUrl: async (hash) => ({ url: `blob:${hash}`, expiresIn: 60 }),
        postAnalyses: async () => {
          throw new Error("resume must not submit");
        },
        getAnalyses: async (hash) => ({
          assetHash: hash,
          stages: [
            { stage: "ingest", status: "done", blob: ingest.hash },
            { stage: "rhythm", status: "done", blob: rhythm.hash },
          ],
        }),
        library: async () => ({ items: [], nextCursor: null }),
        importLibrary: async () => ({ items: [], enqueuedStages: [] }),
      } as ApiClient,
      realtime,
      songStore: resumedStore,
      fetch: (async (url: string | URL) => {
        const bytes = h.store.get(String(url).replace(/^blob:/, ""));
        return new Response(bytes as unknown as BodyInit, { status: bytes ? 200 : 404 });
      }) as unknown as typeof globalThis.fetch,
      onCommit: (commit) => commits.push(commit.batch?.label ?? ""),
    });
    await flow.resume({ assetHash: result.assetHash });
    expect(realtime.topics()).toContain(`asset:${result.assetHash}`);
    expect(flow.state().message).toBeUndefined();
    expect(commits).toEqual(["Analysis: rhythm"]);
    const doc = resumedStore.store.getState().doc;
    expect(doc?.analyses[doc.sources[0]?.id ?? ""]?.blobs.rhythm).toBe(rhythm.hash);
    // The ingest batch was not applied twice.
    expect(doc?.tracks.length).toBe(snapshot.tracks.length);
  });

  it("does not replay stages onto a version from before them (going back, then reopening)", async () => {
    const h = await harness();
    const workingAsset = await registerAudio(h.store, "working");
    const ingest = await register(h.store, {
      schemaVersion: 1,
      workingAsset,
      durationSec: 30,
      channelsOriginal: 1,
      sampleRateOriginal: 48000,
      codec: "wav",
      fingerprint: "fp",
    });
    const rhythm = await register(h.store, {
      schemaVersion: 1,
      bpm: 90,
      beats: [0, 0.66],
      downbeats: [0],
      tempoCurve: [{ beat: 0, bpm: 90 }],
      timeSignature: { numerator: 4, denominator: 4 },
      confidence: 0.9,
      isTempoStable: true,
    });
    h.postAnalysesEmit("ingest", ingest);
    const result = await h.flow.start({ name: "song.wav", bytes: async () => new Uint8Array([8]) });
    h.partial("rhythm", rhythm);
    await drain();
    h.flow.dispose();

    // The user went back to the first version: HEAD is the ingest root, without rhythm.
    const before = await listCommits(h.platform.localDb, result.projectId);
    const root = before[0];
    if (root === undefined) throw new Error("no root commit");
    const deviceId = await getDeviceId(h.platform.localDb);
    await setRef(h.platform.localDb, result.projectId, headRef(deviceId), root.id, new Date());
    const rootDoc = await readCommitSnapshot(h.platform, root.snapshotHash);
    expect(rootDoc.analyses[rootDoc.sources[0]?.id ?? ""]?.blobs.rhythm).toBeUndefined();

    const resumedStore = createSongStore(await loadTestModel());
    resumedStore.load(rootDoc, [
      {
        hash: workingAsset,
        mime: "audio/flac",
        bytes: 0,
        sampleRate: 48000,
        channels: 2,
        durationSamples: 30 * 48000,
      },
    ]);
    const commits: string[] = [];
    const flow = createUploadFlow({
      platform: h.platform,
      api: {
        baseUrl: "",
        meta: async () => ({ apiVersion: "1", minClientVersion: "1", features: {} }),
        getAuthMode: async () => ({ mode: "multi-user", user: null }),
        signInWithEmail: async () => {},
        presign: async () => {
          throw new Error("resume must not upload");
        },
        complete: async () => {
          throw new Error("resume must not upload");
        },
        assetUrl: async (hash) => ({ url: `blob:${hash}`, expiresIn: 60 }),
        postAnalyses: async () => {
          throw new Error("resume must not submit");
        },
        getAnalyses: async (hash) => ({
          assetHash: hash,
          stages: [
            { stage: "ingest", status: "done", blob: ingest.hash },
            { stage: "rhythm", status: "done", blob: rhythm.hash },
          ],
        }),
        library: async () => ({ items: [], nextCursor: null }),
        importLibrary: async () => ({ items: [], enqueuedStages: [] }),
      } as ApiClient,
      realtime: new FakeRealtime(),
      songStore: resumedStore,
      fetch: (async (url: string | URL) => {
        const bytes = h.store.get(String(url).replace(/^blob:/, ""));
        return new Response(bytes as unknown as BodyInit, { status: bytes ? 200 : 404 });
      }) as unknown as typeof globalThis.fetch,
      onCommit: (commit) => commits.push(commit.batch?.label ?? ""),
    });
    await flow.resume({ assetHash: result.assetHash });
    expect(commits).toEqual([]);
    expect(await listCommits(h.platform.localDb, result.projectId)).toHaveLength(before.length);
    const doc = resumedStore.store.getState().doc;
    expect(doc?.analyses[doc.sources[0]?.id ?? ""]?.blobs.rhythm).toBeUndefined();
  });
});
