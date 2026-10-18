/**
 * Browser adapters (01 §3): sqlite-wasm + OPFS in a dedicated worker, OPFS
 * blobs, `<input>` file picking. Requires cross-origin isolation, which
 * apps/web's server headers provide.
 */
import { runMigrations } from "../migrations.js";
import type { Migration, Platform } from "../types.js";
import { createInputFileAccess } from "./file-access.js";
import { connectStorage, type MessageEndpoint } from "./protocol.js";

export interface WebPlatformOptions {
  readonly migrations: readonly Migration[];
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
  };
}

export {
  type AssetResolver,
  createBlobCacheAssetResolver,
  createBrowserEngineHost,
  createWasmEngineHost,
  type EngineAsset,
  type EngineOfflineBridge,
  type EnginePlaybackBridge,
  guessMime,
  stateWordCount,
  type WasmEngineHostOptions,
} from "./engine.js";
export { createInputFileAccess } from "./file-access.js";
