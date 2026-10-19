/**
 * The real browser bridges: an `AudioWorkletNode` running `bragi-engine` in WASM, plus an optional
 * offline worker (specs/03-audio-engine.md §3.1).
 *
 * This needs a browser: cross-origin isolation for `SharedArrayBuffer`, an `AudioContext`, and two
 * URLs the host application's bundler provides (the platform package is plain `tsc` output and
 * cannot resolve them itself):
 *
 * - `workletUrl`: the bundled `engine-processor.js` (the worklet module, wasm glue inlined).
 * - `wasmUrl`: `bragi_engine_wasm_bg.wasm`, fetched here and handed to the worklet.
 *
 * It is exercised by the web e2e suite (`apps/web/e2e/song-canvas.spec.ts`), not by Vitest; the
 * host logic above it (`createWasmEngineHost`) is unit-tested with fakes.
 */
import { applyMixDelta } from "../engine/delta.js";
import type { EngineDelta, EngineHost, ProjectJson, RenderResult } from "../engine/types.js";
import type { BlobCache } from "../types.js";
import {
  createBlobCacheAssetResolver,
  createStateBlock,
  createWasmEngineHost,
  type EngineAsset,
  type EngineOfflineBridge,
  type EnginePlaybackBridge,
} from "./engine.js";

/** What the host application hands in. */
export interface BrowserEngineOptions {
  readonly blobCache: BlobCache;
  readonly workletUrl: string | URL;
  readonly wasmUrl: string | URL;
  /**
   * The offline worker (`engine.worker.ts`). Without one, `render` and `peaks` reject: the Song
   * Canvas draws from analysis data and needs neither.
   */
  readonly worker?: Worker;
  readonly sampleRate?: 48000;
}

interface WorkletMessage {
  readonly type: "ready" | "loaded" | "error";
  readonly tracks?: number;
  readonly message?: string;
}

/** Creates the browser `EngineHost`. Call from a user gesture so the context may start. */
export async function createBrowserEngineHost(options: BrowserEngineOptions): Promise<EngineHost> {
  if (typeof globalThis.AudioContext === "undefined") {
    throw new Error("no AudioContext: the web engine host needs a browser");
  }
  const context = new AudioContext({ sampleRate: options.sampleRate ?? 48000 });
  await context.audioWorklet.addModule(options.workletUrl.toString());
  const node = new AudioWorkletNode(context, "bragi-engine", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });
  node.connect(context.destination);

  let state = createStateBlock(0);
  let currentDoc: ProjectJson | null = null;
  let pendingLoad: { resolve: () => void; reject: (error: Error) => void } | null = null;
  let resolveReady: () => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  node.port.onmessage = (event: MessageEvent<WorkletMessage>): void => {
    const message = event.data;
    if (message.type === "ready") {
      node.port.postMessage({ type: "state", state });
      resolveReady();
    } else if (message.type === "loaded") {
      // The plan decides how many meters the state block needs; swap in a block of that size.
      state = createStateBlock(message.tracks ?? 0);
      node.port.postMessage({ type: "state", state });
      pendingLoad?.resolve();
      pendingLoad = null;
    } else if (message.type === "error") {
      const error = new Error(message.message ?? "engine worklet failed");
      rejectReady(error);
      pendingLoad?.reject(error);
      pendingLoad = null;
    }
  };

  const wasm = await fetch(options.wasmUrl.toString());
  if (!wasm.ok) throw new Error(`could not fetch the engine wasm (${wasm.status})`);
  node.port.postMessage({ type: "wasm", bytes: new Uint8Array(await wasm.arrayBuffer()) });
  await ready;

  const playback: EnginePlaybackBridge = {
    get state() {
      return state;
    },
    send(words) {
      // A transport command comes from a user gesture; this is the moment the context may start.
      if (context.state === "suspended") void context.resume();
      node.port.postMessage({ type: "commands", words: words.map((word) => word.toString()) });
    },
    load(doc: ProjectJson, assets: readonly EngineAsset[]) {
      currentDoc = doc;
      return new Promise<void>((resolve, reject) => {
        pendingLoad = { resolve, reject };
        node.port.postMessage({ type: "load", doc, assets });
      });
    },
    applyDelta(delta: EngineDelta) {
      if (currentDoc === null) return;
      const next = applyMixDelta(currentDoc, delta);
      // `null` means structural: the caller follows with `loadDocument` carrying the new document.
      if (next === null) return;
      currentDoc = next;
      node.port.postMessage({ type: "load", doc: next, assets: [] });
    },
    async dispose() {
      node.port.close();
      node.disconnect();
      await context.close();
    },
  };

  const worker = options.worker;
  const offline: EngineOfflineBridge = {
    render(job) {
      if (!worker) return Promise.reject(new Error("no offline worker was provided"));
      const format =
        job.kind === "mixdown" || job.kind === "stems"
          ? job.format
          : ({ container: "wav", bits: 32 } as const);
      return request<RenderResult>(worker, {
        type: "render",
        start: job.kind === "mixdown" ? (job.startSample ?? 0) : 0,
        frames: job.kind === "mixdown" ? (job.frames ?? 0) : 0,
        format,
      });
    },
    peaks(asset, level) {
      if (!worker) return Promise.reject(new Error("no offline worker was provided"));
      return request<Float32Array>(worker, { type: "peaks", asset, level });
    },
    spectrogram() {
      return Promise.reject(new Error("spectrogram is not in v1 (specs/15-open-questions.md Q26)"));
    },
    async dispose() {
      worker?.terminate();
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
