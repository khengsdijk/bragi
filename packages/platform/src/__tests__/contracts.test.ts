/**
 * Runs the shared contract suites against every implementation that can run
 * in Node. What is *not* here, and where it is covered instead:
 * - OPFS (sqlite-wasm's opfs-sahpool VFS, the OPFS blob directory): browsers
 *   only → apps/web/e2e in Chromium, Firefox and WebKit.
 * - the Rust commands behind the Tauri adapters: `cargo test` in
 *   apps/desktop/src-tauri, and the desktop selftest end to end.
 */
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

import { createMemoryBlobCache } from "../memory.js";
import { localDbFromEngine } from "../sync-engine.js";
import { createTauriBlobCache, createTauriLocalDb } from "../tauri/adapters.js";
import { createNodeSqliteDb } from "../testing/node-sqlite-db.js";
import { connectStorage, type MessageEndpoint, serveStorage } from "../web/protocol.js";
import { sqliteWasmEngine } from "../web/sqlite-wasm-engine.js";
import { describeBlobCacheContract } from "./contract/blob-cache.js";
import { describeLocalDbContract } from "./contract/local-db.js";
import { createTauriIpcDouble } from "./tauri-ipc-double.js";

const sqlite3 = await sqlite3InitModule();

/** The web stack minus OPFS: page proxy ⇄ MessageChannel ⇄ worker server ⇄ sqlite-wasm. */
async function webStackOverMessageChannel() {
  const channel = new MessageChannel();
  serveStorage(
    channel.port1 as unknown as MessageEndpoint,
    Promise.resolve({
      db: localDbFromEngine(sqliteWasmEngine(new sqlite3.oo1.DB(":memory:"))),
      blobs: createMemoryBlobCache(),
    }),
  );
  return connectStorage(channel.port2 as unknown as MessageEndpoint);
}

describeLocalDbContract("node:sqlite fake", async () => createNodeSqliteDb());
describeLocalDbContract("sqlite-wasm engine (in memory)", async () =>
  localDbFromEngine(sqliteWasmEngine(new sqlite3.oo1.DB(":memory:"))),
);
describeLocalDbContract(
  "web worker protocol over a MessageChannel",
  async () => (await webStackOverMessageChannel()).localDb,
);
describeLocalDbContract("Tauri adapter (IPC double)", async () =>
  createTauriLocalDb(createTauriIpcDouble()),
);

describeBlobCacheContract("in-memory", async () => createMemoryBlobCache());
describeBlobCacheContract(
  "web worker protocol over a MessageChannel",
  async () => (await webStackOverMessageChannel()).blobCache,
);
describeBlobCacheContract("Tauri adapter (IPC double)", async () =>
  createTauriBlobCache(createTauriIpcDouble()),
);
