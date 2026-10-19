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
import { createTauriEngineHost } from "./engine.js";

export interface TauriPlatformOptions {
  readonly migrations: readonly Migration[];
}

/**
 * The raw IPC call, for tooling that has to reach a command the app itself never
 * needs. Only the desktop end-to-end harness uses it: it reports its transcript
 * through `selftest_report` (apps/desktop/src-tauri/src/selftest.rs), which is
 * granted to the harness window alone. Keeping it here means `@tauri-apps/*` is
 * still imported in exactly one place (13 §1 rule 9).
 */
export function createTauriIpc(): Invoke {
  return (command, args) => invoke(command, args);
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
    // Dev default; the "compute server" setting (05 §10) will supply this later.
    // The local API runs in single-user mode (ADR-0014), so it needs no
    // credential at all; bearer/PKCE is for hosted multi-user mode (WP-2.9).
    api: { baseUrl: "http://127.0.0.1:8080", credential: "bearer" },
    createEngine: () => createTauriEngineHost({ invoke: ipc }),
  };
}

export { createTauriBlobCache, createTauriLocalDb, type Invoke } from "./adapters.js";
export { createTauriEngineHost, type TauriEngineOptions } from "./engine.js";
