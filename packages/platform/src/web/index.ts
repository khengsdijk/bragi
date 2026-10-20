/**
 * Browser adapters (01 §3): sqlite-wasm + OPFS in a dedicated worker, OPFS
 * blobs, `<input>` file picking. Requires cross-origin isolation, which
 * apps/web's server headers provide.
 */
import { runMigrations } from "../migrations.js";
import type { Migration, Platform } from "../types.js";
import { createBrowserEngine } from "./browser-engine.js";
import { createInputFileAccess } from "./file-access.js";
import { connectStorage, type MessageEndpoint } from "./protocol.js";

export interface WebPlatformOptions {
  readonly migrations: readonly Migration[];
  /**
   * Where the host bundler put the engine worklet and its wasm. Without it the platform has no
   * audio engine (`createEngine` is absent).
   */
  readonly engine?: BrowserEngineAssets;
}

/** URLs of the three engine files the host application serves (see `createBrowserEngine`). */
export interface BrowserEngineAssets {
  readonly workletUrl: string;
  readonly workerUrl: string;
  readonly wasmUrl: string;
}

export async function createWebPlatform(options: WebPlatformOptions): Promise<Platform> {
  const worker = new Worker(new URL("./storage.worker.js", import.meta.url), {
    type: "module",
    name: "bragi-storage",
  });
  const storage = await connectStorage(worker as MessageEndpoint);
  await runMigrations(storage.localDb, options.migrations);
  const engine = options.engine
    ? createBrowserEngine({
        blobCache: storage.blobCache,
        workletUrl: options.engine.workletUrl,
        workerUrl: options.engine.workerUrl,
        wasmUrl: options.engine.wasmUrl,
      })
    : null;
  return {
    kind: "web",
    localDb: storage.localDb,
    blobCache: storage.blobCache,
    fileAccess: createInputFileAccess(document),
    api: { baseUrl: "", credential: "cookie" },
    ...(engine
      ? {
          createEngine: () => engine.create(),
          primeEngine: () => engine.prime(),
        }
      : {}),
  };
}

export {
  type BrowserEngine,
  type BrowserEngineOptions,
  createBrowserEngine,
  createBrowserEngineHost,
} from "./browser-engine.js";
export {
  type AssetResolver,
  createBlobCacheAssetResolver,
  createWasmEngineHost,
  type EngineAsset,
  type EngineAssetBytes,
  type EngineOfflineBridge,
  type EnginePlaybackBridge,
  guessMime,
  stateWordCount,
  type WasmEngineHostOptions,
} from "./engine.js";
export { createInputFileAccess } from "./file-access.js";
