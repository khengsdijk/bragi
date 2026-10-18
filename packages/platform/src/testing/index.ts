/**
 * Test doubles for code written against `@bragi/platform`. Node-only (it uses
 * `node:sqlite`); never import it from browser code.
 */
import { createMemoryBlobCache, createScriptedFileAccess } from "../memory.js";
import { runMigrations } from "../migrations.js";
import type { Migration, Platform } from "../types.js";
import { createNodeSqliteDb } from "./node-sqlite-db.js";

export { createNodeSqliteDb } from "./node-sqlite-db.js";

/** A complete in-memory platform: real SQLite (node:sqlite), Map-backed blobs, no files. */
export async function createMemoryPlatform(
  migrations: readonly Migration[] = [],
): Promise<Platform> {
  const localDb = createNodeSqliteDb();
  await runMigrations(localDb, migrations);
  return {
    kind: "memory",
    localDb,
    blobCache: createMemoryBlobCache(),
    fileAccess: createScriptedFileAccess([]),
  };
}
