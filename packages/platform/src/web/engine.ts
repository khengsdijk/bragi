/**
 * The browser `EngineHost` (specs/03-audio-engine.md §3.1).
 *
 * ```
 *  UI ──commands──► SharedArrayBuffer ring ──► AudioWorklet (bragi-engine in WASM)
 *  UI ◄──state block (playhead, meters)───────  writes atomics every quantum
 *                    decoder worker ──PCM──►  the worklet's chunk pool
 * ```
 *
 * The class is split from the browser wiring on purpose: {@link createWasmEngineHost}
 * takes two small bridges (`playback`, `offline`) and implements the full
 * {@link EngineHost} contract, so every method is testable in Node with fakes.
 * {@link createBrowserEngineHost} builds the real bridges from an
 * `AudioWorkletNode` and a worker.
 *
 * `spectrogram` is not in v1: the method exists (the interface is shared) and
 * rejects with a typed error rather than pretending.
 */
import {
  decodeStateWords,
  encodeTransport,
  packCommand,
  STATE_HEADER_WORDS,
} from "../engine/codec.js";
import type {
  AssetHash,
  EngineDelta,
  EngineEvent,
  EngineHost,
  EngineState,
  PeakLevel,
  PreviewPatch,
  ProjectJson,
  RenderJob,
  RenderResult,
  TileSpec,
  TransportCmd,
} from "../engine/types.js";
import type { BlobCache } from "../types.js";

/** Opcodes the worklet understands beyond the transport set. */
export const OP_LOAD = 16;
/** Carries a decoded PCM chunk handle (the chunk-pool protocol). */
export const OP_CHUNK = 17;
/** Clears the plan (a project was closed). */
export const OP_CLEAR = 18;

/**
 * The audio-thread half of the host: an engine in an AudioWorklet.
 *
 * The real implementation owns the `AudioWorkletNode`, the command ring and the
 * shared state block. `load` hands it the document and the decoded PCM; the
 * concrete browser bridge registers chunks into the worklet's pool.
 */
export interface EnginePlaybackBridge {
  /** A view of the shared state block the worklet publishes. */
  readonly state: Uint32Array;
  /** Pushes command words into the lock-free ring. */
  send(words: readonly bigint[]): void;
  /** Installs a document and its decoded assets on the audio thread. */
  load(doc: ProjectJson, assets: readonly EngineAsset[]): Promise<void>;
  /**
   * Applies a committed mix change (track gain/pan/mute/solo, master gain)
   * without a full plan reload. Structural changes arrive through `load`.
   */
  applyDelta(delta: EngineDelta): void;
  /** Releases the worklet and its buffers. */
  dispose(): Promise<void>;
}

/** Decoded PCM handed to the playback bridge. */
export interface EngineAsset {
  readonly hash: AssetHash;
  readonly bytes: Uint8Array;
  readonly mime: string;
}

/** The offline half of the host: the wasm engine in a worker. */
export interface EngineOfflineBridge {
  /** Renders a job offline (`Render` stretch quality). */
  render(job: RenderJob): Promise<RenderResult>;
  /** One pyramid level, as `[min, max]` pairs. */
  peaks(asset: AssetHash, level: PeakLevel): Promise<Float32Array>;
  /** Spectrogram tiles, when the host has them. */
  spectrogram(asset: AssetHash, tile: TileSpec): Promise<Uint8Array>;
  /** Releases the worker. */
  dispose(): Promise<void>;
}

/** Where decoded PCM comes from: the content-addressed blob cache. */
export interface AssetResolver {
  /** Registers a document's assets before `load` is called. */
  prepare(doc: ProjectJson): Promise<readonly EngineAsset[]>;
}

export interface WasmEngineHostOptions {
  readonly playback: EnginePlaybackBridge;
  readonly offline: EngineOfflineBridge;
  readonly assets?: AssetResolver;
  /** How the state stream is polled; defaults to `requestAnimationFrame`. */
  readonly schedule?: (callback: () => void) => number;
  readonly cancelSchedule?: (handle: number) => void;
}

const DEFAULT_INTERVAL_MS = 1000 / 60;

/**
 * Builds an `EngineHost` from the two bridges. Every UI-facing method lives
 * here; the bridges only know about their side of the wire.
 */
export function createWasmEngineHost(options: WasmEngineHostOptions): EngineHost {
  const stateListeners = new Set<(state: EngineState) => void>();
  const eventListeners = new Set<(event: EngineEvent) => void>();
  const schedule =
    options.schedule ??
    ((callback: () => void) =>
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(callback)
        : (setTimeout(callback, DEFAULT_INTERVAL_MS) as unknown as number));
  const cancelSchedule =
    options.cancelSchedule ??
    ((handle: number) => {
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle);
      else clearTimeout(handle);
    });

  let running = false;
  let handle: number | null = null;
  let lastVersion = -1;
  let disposed = false;

  const tick = (): void => {
    if (!running) return;
    const state = decodeStateWords(options.playback.state);
    for (const listener of stateListeners) listener(state);
    if (state.planVersion !== lastVersion) {
      lastVersion = state.planVersion;
      emit({ kind: "planCompiled", version: state.planVersion });
    }
    if (state.underruns > 0) {
      emit({ kind: "underrun", sample: state.playhead, count: state.underruns });
    }
    handle = schedule(tick);
  };

  const emit = (event: EngineEvent): void => {
    for (const listener of eventListeners) listener(event);
  };

  const assertLive = (): void => {
    if (disposed) throw new Error("the engine host is disposed");
  };

  return {
    async init() {
      assertLive();
      if (running) return;
      running = true;
      handle = schedule(tick);
    },
    async loadDocument(doc) {
      assertLive();
      const assets = options.assets ? await options.assets.prepare(doc) : [];
      await options.playback.load(doc, assets);
      options.playback.send([packCommand(OP_LOAD, 0)]);
    },
    applyDelta(delta: EngineDelta) {
      assertLive();
      // Mix-only deltas are applied on the audio thread without a plan reload;
      // structural ones (`requiresFullResync`) are recompiled by the next
      // `loadDocument`, which the Song Store issues for that commit.
      options.playback.applyDelta(delta);
    },
    setPreview(preview: PreviewPatch | null) {
      assertLive();
      if (preview === null) {
        options.playback.send([packCommand(OP_LOAD, 0)]);
        emit({ kind: "previewChanged", active: false });
        return;
      }
      options.playback.send([packCommand(OP_LOAD, 0)]);
      emit({ kind: "previewChanged", active: true });
      void preview;
    },
    transport(cmd: TransportCmd) {
      assertLive();
      options.playback.send(encodeTransport(cmd));
    },
    audition(target) {
      assertLive();
      if (target === null) {
        options.playback.send(encodeTransport({ kind: "audition", on: false }));
        return;
      }
      options.playback.send(encodeTransport({ kind: "audition", on: true }));
    },
    render(job) {
      assertLive();
      return options.offline.render(job);
    },
    peaks(asset, level) {
      assertLive();
      return options.offline.peaks(asset, level);
    },
    spectrogram(asset, tile) {
      assertLive();
      return options.offline.spectrogram(asset, tile);
    },
    onState(cb) {
      stateListeners.add(cb);
      return () => stateListeners.delete(cb);
    },
    onEvent(cb) {
      eventListeners.add(cb);
      return () => eventListeners.delete(cb);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      running = false;
      if (handle !== null) cancelSchedule(handle);
      stateListeners.clear();
      eventListeners.clear();
      await options.playback.dispose();
      await options.offline.dispose();
    },
  };
}

/** The number of meter words an `EngineState` needs for `tracks` tracks. */
export function stateWordCount(tracks: number): number {
  return STATE_HEADER_WORDS + tracks * 2 + 2;
}

/** Every asset hash a document references (sources and clips). */
export function collectAssetHashes(doc: ProjectJson): AssetHash[] {
  const hashes = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.startsWith("sha256:") && value.length === 71) hashes.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value)) visit(item);
    }
  };
  visit(doc);
  return [...hashes] as AssetHash[];
}

/**
 * A resolver over a `BlobCache`: fetches the bytes the document references.
 *
 * A missing blob is skipped here and surfaces as silence plus an underrun from
 * the engine, which is the documented behaviour (`specs/03-audio-engine.md`
 * §3.1) — a document that references an asset the local cache does not have must
 * still load.
 */
export function createBlobCacheAssetResolver(blobCache: BlobCache): AssetResolver {
  return {
    async prepare(doc) {
      const assets: EngineAsset[] = [];
      for (const hash of collectAssetHashes(doc)) {
        const bytes = await blobCache.get(hash);
        if (!bytes) continue;
        assets.push({ hash, bytes, mime: guessMime(bytes) });
      }
      return assets;
    },
  };
}

/** Guesses a container from the magic bytes, for the decoder hint. */
export function guessMime(bytes: Uint8Array): string {
  const ascii = (offset: number, length: number): string =>
    String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") return "audio/wav";
  if (bytes.length >= 4 && ascii(0, 4) === "fLaC") return "audio/flac";
  if (bytes.length >= 3 && ascii(0, 3) === "ID3") return "audio/mpeg";
  if (bytes.length >= 2 && bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)
    return "audio/mpeg";
  if (bytes.length >= 4 && ascii(0, 4) === "OggS") return "audio/ogg";
  if (bytes.length >= 12 && ascii(4, 4) === "ftyp") return "audio/mp4";
  return "application/octet-stream";
}

/** The browser's shared-array-buffer state block, if it can be created. */
export function createStateBlock(tracks: number): Uint32Array {
  return new Uint32Array(new SharedArrayBuffer(stateWordCount(tracks) * 4));
}

/**
 * Builds the real browser bridges (AudioWorklet + worker).
 *
 * This needs a browser: cross-origin isolation for `SharedArrayBuffer`, an
 * `AudioContext` started from a user gesture, and the generated
 * `crates/bragi-engine-wasm/pkg` module served to both the worklet and the
 * worker. It is exercised by the web e2e suite, not by Vitest.
 */
export async function createBrowserEngineHost(options: {
  readonly blobCache: BlobCache;
  readonly workletUrl: string | URL;
  readonly worker: Worker;
  readonly sampleRate?: 48000;
  readonly tracks?: number;
}): Promise<EngineHost> {
  if (typeof globalThis.AudioContext === "undefined") {
    throw new Error("no AudioContext: the web engine host needs a browser");
  }
  const AudioContextCtor = globalThis.AudioContext as typeof AudioContext;
  const context = new AudioContextCtor({ sampleRate: options.sampleRate ?? 48000 });
  await context.audioWorklet.addModule(options.workletUrl);
  const node = new AudioWorkletNode(context, "bragi-engine", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });
  node.connect(context.destination);
  const state = createStateBlock(options.tracks ?? 0);
  const commands = new BigInt64Array(new SharedArrayBuffer(1024 * 8));
  node.port.postMessage({ type: "state", state }, [state.buffer]);
  node.port.postMessage({ type: "commands", commands }, [commands.buffer]);

  const playback: EnginePlaybackBridge = {
    state,
    send(words) {
      node.port.postMessage({ type: "commands", words: words.map((word) => word.toString()) });
    },
    async load(doc, assets) {
      node.port.postMessage({ type: "load", doc, assets });
    },
    applyDelta(delta) {
      node.port.postMessage({ type: "delta", delta });
    },
    async dispose() {
      node.port.close();
      node.disconnect();
      await context.close();
    },
  };
  const offline: EngineOfflineBridge = {
    render(job) {
      return request<RenderResult>(options.worker, { type: "render", job });
    },
    peaks(asset, level) {
      return request<Float32Array>(options.worker, { type: "peaks", asset, level });
    },
    spectrogram() {
      return Promise.reject(new Error("spectrogram is not in v1 (specs/15-open-questions.md Q26)"));
    },
    async dispose() {
      options.worker.terminate();
    },
  };
  return createWasmEngineHost({
    playback,
    offline,
    assets: createBlobCacheAssetResolver(options.blobCache),
  });
}

let requestCounter = 0;

/** A promise-style request over `postMessage`. */
function request<T>(worker: Worker, message: Record<string, unknown>): Promise<T> {
  const id = ++requestCounter;
  return new Promise<T>((resolve, reject) => {
    const onMessage = (event: MessageEvent): void => {
      const data = event.data as { id?: number; ok?: boolean; result?: T; error?: string };
      if (data.id !== id) return;
      worker.removeEventListener("message", onMessage);
      if (data.ok) resolve(data.result as T);
      else reject(new Error(data.error ?? "engine worker failed"));
    };
    worker.addEventListener("message", onMessage);
    worker.postMessage({ ...message, id });
  });
}
