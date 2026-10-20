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

/** Compressed bytes of one asset, before the decoder worker sees them. */
export interface EngineAssetBytes {
  readonly hash: AssetHash;
  readonly bytes: Uint8Array;
  readonly mime: string;
}

/** Decoded PCM handed to the playback bridge. */
export interface EngineAsset {
  readonly hash: AssetHash;
  /** Interleaved at `channels`, already at the engine's output rate. */
  readonly samples: Float32Array;
  readonly channels: number;
  readonly sampleRate: number;
}

/** The offline half of the host: the wasm engine in a worker. */
export interface EngineOfflineBridge {
  /** Decodes compressed assets off the audio thread. */
  decode(assets: readonly EngineAssetBytes[]): Promise<readonly EngineAsset[]>;
  /** Renders a job offline (`Render` stretch quality). */
  render(job: RenderJob): Promise<RenderResult>;
  /** One pyramid level, as `[min, max]` pairs. */
  peaks(asset: AssetHash, level: PeakLevel): Promise<Float32Array>;
  /** Spectrogram tiles, when the host has them. */
  spectrogram(asset: AssetHash, tile: TileSpec): Promise<Uint8Array>;
  /** Releases the worker. */
  dispose(): Promise<void>;
}

/** Where compressed audio comes from: the content-addressed blob cache. */
export interface AssetResolver {
  /** Fetches the bytes of the hashes the host does not hold yet. */
  fetch(hashes: readonly AssetHash[]): Promise<readonly EngineAssetBytes[]>;
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
  /** Hashes whose PCM the worklet holds; a structural reload adds to it, never re-sends. */
  const loaded = new Set<AssetHash>();

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
      const missing = collectAssetHashes(doc).filter((hash) => !loaded.has(hash));
      let assets: readonly EngineAsset[] = [];
      if (missing.length > 0 && options.assets) {
        const bytes = await options.assets.fetch(missing);
        if (bytes.length > 0) assets = await options.offline.decode(bytes);
      }
      await options.playback.load(doc, assets);
      // Marked only after the worklet accepted the load, so a failed post can retry.
      for (const asset of assets) loaded.add(asset.hash);
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

/**
 * Every audio asset hash a document references (sources, clips, stems).
 *
 * `analyses.*.blobs` are the analysis result blobs (JSON, 02 §6): they are content-addressed like
 * assets and sit in the same BlobCache, but they are not audio and the decoder must never see them.
 */
export function collectAssetHashes(doc: ProjectJson): AssetHash[] {
  const hashes = new Set<string>();
  const visit = (value: unknown, key?: string): void => {
    if (key === "blobs") return;
    if (typeof value === "string") {
      if (value.startsWith("sha256:") && value.length === 71) hashes.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const [name, item] of Object.entries(value)) visit(item, name);
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
    async fetch(hashes) {
      const assets: EngineAssetBytes[] = [];
      for (const hash of hashes) {
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
 * A state block for a new plan's track count that keeps `previous`'s header (transport,
 * playhead). The worklet starts writing the new block a few quanta after a reload; a zeroed
 * header would read as "stopped at 0" until then, and the transport bar would flicker back to
 * Play on every structural edit.
 */
export function resizeStateBlock(previous: Uint32Array, tracks: number): Uint32Array {
  const next = createStateBlock(tracks);
  next.set(previous.subarray(0, Math.min(STATE_HEADER_WORDS, previous.length, next.length)));
  return next;
}
