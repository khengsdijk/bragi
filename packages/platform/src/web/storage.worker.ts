/**
 * The browser storage worker (01 §3: "sqlite-wasm on OPFS (in a Worker)").
 * Owns the database connection and the OPFS blob directory; the page talks to
 * it through ./protocol.ts.
 */
import sqlite3InitModule, { type SAHPoolUtil, type Sqlite3Static } from "@sqlite.org/sqlite-wasm";

import { localDbFromEngine } from "../sync-engine.js";
import { createOpfsBlobCache } from "./opfs-blob-cache.js";
import { type MessageEndpoint, type StorageBackend, serveStorage } from "./protocol.js";
import { sqliteWasmEngine } from "./sqlite-wasm-engine.js";

const DB_FILE = "/bragi.sqlite3";

/**
 * The opfs-sahpool VFS holds an exclusive lock on its files. After a reload the
 * previous page's worker may not have released it yet, so installation is
 * retried briefly before giving up.
 */
async function installPool(sqlite3: Sqlite3Static): Promise<SAHPoolUtil> {
  const deadline = Date.now() + 10_000;
  for (let delayMs = 50; ; delayMs = Math.min(delayMs * 2, 1_000)) {
    try {
      return await sqlite3.installOpfsSAHPoolVfs({ name: "bragi-sahpool", directory: ".bragi-db" });
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function open(): Promise<StorageBackend> {
  const sqlite3 = await sqlite3InitModule();
  const pool = await installPool(sqlite3);
  const db = new pool.OpfsSAHPoolDb(DB_FILE);
  db.exec("PRAGMA foreign_keys = ON");
  return { db: localDbFromEngine(sqliteWasmEngine(db)), blobs: await createOpfsBlobCache() };
}

serveStorage(globalThis as unknown as MessageEndpoint, open());
