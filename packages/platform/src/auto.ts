/**
 * Picks the adapter set for the host the bundle is running in. The web build
 * and the desktop app load the *same* bundle (01 §3), so this is a runtime
 * decision; each adapter set is a separate lazy chunk.
 */
import type { Migration, Platform } from "./types.js";

/** True inside a Tauri webview, which injects its IPC bridge before any page script runs. */
export function isTauriHost(scope: object = globalThis): boolean {
  return "__TAURI_INTERNALS__" in scope;
}

export interface PlatformOptions {
  readonly migrations: readonly Migration[];
  /** The bundled engine worklet, decoder worker and wasm URLs, used by the web adapters only. */
  readonly webEngine?: {
    readonly workletUrl: string;
    readonly workerUrl: string;
    readonly wasmUrl: string;
  };
}

export async function createPlatform(options: PlatformOptions): Promise<Platform> {
  if (isTauriHost()) {
    const { createTauriPlatform } = await import("./tauri/index.js");
    return createTauriPlatform(options);
  }
  const { createWebPlatform } = await import("./web/index.js");
  return createWebPlatform({
    migrations: options.migrations,
    ...(options.webEngine ? { engine: options.webEngine } : {}),
  });
}
