/**
 * Browser adapters (01 §3): sqlite-wasm + OPFS in a dedicated worker, OPFS
 * blobs, `<input>` file picking. Requires cross-origin isolation, which
 * apps/web's server headers provide.
 */
import { runMigrations } from "../migrations.js";
import type { Migration, Platform } from "../types.js";
import { createBrowserEngineHost } from "./browser-engine.js";
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

/** URLs of the two engine files the host application serves (see `createBrowserEngineHost`). */
export interface BrowserEngineAssets {
  readonly workletUrl: string;
  readonly wasmUrl: string;
}

export async function createWebPlatform(options: WebPlatformOptions): Promise<Platform> {
  const worker = new Worker(new URL("./storage.worker.js", import.meta.url), {
    type: "module",
    name: "bragi-storage",
  });
  const storage = await connectStorage(worker as MessageEndpoint);
  await runMigrations(storage.localDb, options.migrations);
  return {
    kind: "web",
    localDb: storage.localDb,
    blobCache: storage.blobCache,
    fileAccess: createInputFileAccess(document),
    ...(options.engine
      ? {
          createEngine: () =>
            createBrowserEngineHost({
              blobCache: storage.blobCache,
              workletUrl: options.engine?.workletUrl ?? "",
              wasmUrl: options.engine?.wasmUrl ?? "",
            }),
        }
      : {}),
  };
}

export { type BrowserEngineOptions, createBrowserEngineHost } from "./browser-engine.js";
export {
  type AssetResolver,
  createBlobCacheAssetResolver,
  createWasmEngineHost,
  type EngineAsset,
  type EngineOfflineBridge,
  type EnginePlaybackBridge,
  guessMime,
  stateWordCount,
  type WasmEngineHostOptions,
} from "./engine.js";
export { createInputFileAccess } from "./file-access.js";
