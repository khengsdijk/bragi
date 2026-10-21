/**
 * The real browser bridges: an `AudioWorkletNode` running `bragi-engine` in WASM, plus the
 * decoder/offline worker (specs/03-audio-engine.md §3.1).
 *
 * This needs a browser: cross-origin isolation for `SharedArrayBuffer`, an `AudioContext`, and
 * three URLs the host application's bundler provides (the platform package is plain `tsc` output
 * and cannot resolve them itself):
 *
 * - `workletUrl`: the bundled `engine-processor.js` (the worklet module, wasm glue inlined).
 * - `workerUrl`: the bundled `engine.worker.js`, which decodes compressed assets off the audio
 *   thread. It gets the same wasm bytes as the worklet.
 * - `wasmUrl`: `bragi_engine_wasm_bg.wasm`, fetched here and handed to both.
 *
 * {@link createBrowserEngine} splits the context from the rest: {@link BrowserEngine.prime} is
 * synchronous so the controller can create or resume the `AudioContext` inside the Play click,
 * and {@link BrowserEngine.create} awaits the worklet module and the wasm. It is exercised by the
 * web e2e suite (`apps/web/e2e/reopen-play.spec.ts`), not by Vitest; the host logic above it
 * (`createWasmEngineHost`) is unit-tested with fakes.
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
  resizeStateBlock,
} from "./engine.js";

/** What the host application hands in. */
export interface BrowserEngineOptions {
  readonly blobCache: BlobCache;
  readonly workletUrl: string | URL;
  readonly workerUrl: string | URL;
  readonly wasmUrl: string | URL;
  readonly sampleRate?: 48000;
}

interface WorkletMessage {
  readonly type: "ready" | "loaded" | "warmed" | "error";
  readonly tracks?: number;
  readonly slot?: number;
  readonly ok?: boolean;
  readonly message?: string;
}

interface WorkerMessage {
  readonly type: "ready" | "error";
  readonly message?: string;
}

/** The two halves of a browser engine, so the first can run inside a click. */
export interface BrowserEngine {
  /**
   * Creates the `AudioContext`, or resumes a suspended one. Synchronous on purpose: browsers only
   * start audio while the user activation of the click is still on the stack.
   */
  prime(): void;
  /** Builds the host, reusing a context that {@link prime} created. */
  create(): Promise<EngineHost>;
}

/** Creates the browser engine. Call {@link BrowserEngine.prime} from a user gesture. */
export function createBrowserEngine(options: BrowserEngineOptions): BrowserEngine {
  let context: AudioContext | null = null;

  const ensureContext = (): AudioContext => {
    if (typeof globalThis.AudioContext === "undefined") {
      throw new Error("no AudioContext: the web engine host needs a browser");
    }
    if (context !== null && context.state !== "closed") return context;
    context = new AudioContext({ sampleRate: options.sampleRate ?? 48000 });
    return context;
  };

  return {
    prime() {
      try {
        const started = ensureContext();
        if (started.state === "suspended") void started.resume();
      } catch {
        // `create()` reports the reason; a click must not throw.
      }
    },
    async create() {
      const ctx = ensureContext();
      const worker = new Worker(options.workerUrl.toString(), {
        type: "module",
        name: "bragi-engine-decoder",
      });
      await ctx.audioWorklet.addModule(options.workletUrl.toString());
      const node = new AudioWorkletNode(ctx, "bragi-engine", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      node.connect(ctx.destination);

      let state = createStateBlock(0);
      let currentDoc: ProjectJson | null = null;
      let pendingLoad: { resolve: () => void; reject: (error: Error) => void } | null = null;
      /** One outstanding `warm` per slot; a newer warm of the same slot supersedes the older. */
      const pendingWarm = new Map<
        number,
        { resolve: () => void; reject: (error: Error) => void }
      >();
      let resolveReady: () => void = () => {};
      let rejectReady: (error: Error) => void = () => {};
      const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      let resolveWorker: () => void = () => {};
      let rejectWorker: (error: Error) => void = () => {};
      const workerReady = new Promise<void>((resolve, reject) => {
        resolveWorker = resolve;
        rejectWorker = reject;
      });

      node.port.onmessage = (event: MessageEvent<WorkletMessage>): void => {
        const message = event.data;
        if (message.type === "ready") {
          node.port.postMessage({ type: "state", state });
          resolveReady();
        } else if (message.type === "loaded") {
          // The plan decides how many meters the state block needs; swap in a block of that size,
          // keeping the transport readable until the worklet writes it.
          state = resizeStateBlock(state, message.tracks ?? 0);
          node.port.postMessage({ type: "state", state });
          pendingLoad?.resolve();
          pendingLoad = null;
        } else if (message.type === "warmed") {
          const slot = message.slot ?? 0;
          const pending = pendingWarm.get(slot);
          pendingWarm.delete(slot);
          if (message.ok) pending?.resolve();
          else pending?.reject(new Error(message.message ?? `could not warm slot ${slot}`));
        } else if (message.type === "error") {
          const error = new Error(message.message ?? "engine worklet failed");
          rejectReady(error);
          pendingLoad?.reject(error);
          pendingLoad = null;
        }
      };
      worker.addEventListener("message", (event: MessageEvent<WorkerMessage>): void => {
        if (event.data.type === "ready") resolveWorker();
        else if (event.data.type === "error")
          rejectWorker(new Error(event.data.message ?? "the decoder worker failed"));
      });
      worker.addEventListener("error", (event: ErrorEvent): void => {
        rejectWorker(new Error(event.message || "the decoder worker could not load"));
      });

      const fetched = await fetch(options.wasmUrl.toString());
      if (!fetched.ok) throw new Error(`could not fetch the engine wasm (${fetched.status})`);
      const wasmBytes = new Uint8Array(await fetched.arrayBuffer());
      node.port.postMessage({ type: "wasm", bytes: wasmBytes });
      worker.postMessage({ type: "wasm", bytes: wasmBytes });
      await Promise.all([ready, workerReady]);

      const playback: EnginePlaybackBridge = {
        get state() {
          return state;
        },
        send(words) {
          // A transport command comes from a user gesture; this is the moment the context may start.
          if (ctx.state === "suspended") void ctx.resume();
          node.port.postMessage({ type: "commands", words: words.map((word) => word.toString()) });
        },
        load(doc: ProjectJson, assets: readonly EngineAsset[]) {
          currentDoc = doc;
          return new Promise<void>((resolve, reject) => {
            pendingLoad = { resolve, reject };
            // PCM is handed over, not copied: the worklet copies it into wasm memory once.
            const transfer = assets.flatMap((asset) =>
              asset.samples.buffer instanceof ArrayBuffer ? [asset.samples.buffer] : [],
            );
            node.port.postMessage({ type: "load", doc, assets }, transfer);
          });
        },
        warm(slot, doc, assets) {
          return new Promise<void>((resolve, reject) => {
            pendingWarm.get(slot)?.reject(new Error(`slot ${slot} was warmed again`));
            pendingWarm.set(slot, { resolve, reject });
            const transfer = assets.flatMap((asset) =>
              asset.samples.buffer instanceof ArrayBuffer ? [asset.samples.buffer] : [],
            );
            node.port.postMessage({ type: "warm", slot, doc, assets }, transfer);
          });
        },
        applyDelta(delta: EngineDelta) {
          if (currentDoc === null) return;
          const next = applyMixDelta(currentDoc, delta);
          // `null` means structural: the caller follows with `loadDocument` carrying the new document.
          if (next === null) return;
          currentDoc = next;
          // No PCM: the worklet keeps what it has and only recompiles the plan.
          node.port.postMessage({ type: "load", doc: next, assets: [] });
        },
        async dispose() {
          node.port.close();
          node.disconnect();
          worker.terminate();
          await ctx.close();
          context = null;
        },
      };

      const offline: EngineOfflineBridge = {
        decode(assets) {
          return request<readonly EngineAsset[]>(worker, { type: "decode", assets });
        },
        async load(doc, assets) {
          await request<number>(worker, { type: "load", doc, assets });
        },
        render(job) {
          // WP-1.11: the worker does the encode and returns files, so the whole job goes across.
          return request<RenderResult>(worker, { type: "render", job });
        },
        peaks(asset, level) {
          return request<Float32Array>(worker, { type: "peaks", asset, level });
        },
        spectrogram() {
          return Promise.reject(
            new Error("spectrogram is not in v1 (specs/15-open-questions.md Q26)"),
          );
        },
        async dispose() {
          worker.terminate();
        },
      };

      return createWasmEngineHost({
        playback,
        offline,
        assets: createBlobCacheAssetResolver(options.blobCache),
      });
    },
  };
}

/** Creates the browser `EngineHost`. Prefer {@link createBrowserEngine} so Play can prime first. */
export function createBrowserEngineHost(options: BrowserEngineOptions): Promise<EngineHost> {
  return createBrowserEngine(options).create();
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
