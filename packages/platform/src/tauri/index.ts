/**
 * Desktop adapters (01 §3): rusqlite and the filesystem blob cache behind
 * Tauri commands. Only this module (and ./adapters.ts) may touch
 * `@tauri-apps/*` (13 §1).
 */
import { invoke } from "@tauri-apps/api/core";

import { runMigrations } from "../migrations.js";
import type { Migration, Platform } from "../types.js";
import { createInputFileAccess } from "../web/file-access.js";
import { createTauriBlobCache, createTauriLocalDb, type Invoke } from "./adapters.js";

export interface TauriPlatformOptions {
  readonly migrations: readonly Migration[];
}

export async function createTauriPlatform(options: TauriPlatformOptions): Promise<Platform> {
  const ipc: Invoke = (command, args) => invoke(command, args);
  const localDb = createTauriLocalDb(ipc);
  await runMigrations(localDb, options.migrations);
  return {
    kind: "desktop",
    localDb,
    blobCache: createTauriBlobCache(ipc),
    // The webview's own file input (WKWebView/WebView2/WebKitGTK all show the
    // native panel for it). Native folder pick + watched folders: library import.
    fileAccess: createInputFileAccess(document),
  };
}

export { createTauriBlobCache, createTauriLocalDb, type Invoke } from "./adapters.js";
