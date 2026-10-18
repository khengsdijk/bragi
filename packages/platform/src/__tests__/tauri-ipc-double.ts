/**
 * A stand-in for the Rust side of the Tauri commands, for testing the TS
 * adapters. It mirrors what crosses the real IPC: JSON-serialised arguments, a
 * raw byte body for `blob_put`, an `ArrayBuffer` back from `blob_get`, and
 * `{ kind, message }` rejections. The Rust commands themselves are tested by
 * `cargo test` in apps/desktop/src-tauri and end to end by the selftest.
 */
import { blobHashOf, isBlobHash } from "../blob-hash.js";
import type { Invoke } from "../tauri/adapters.js";
import { createNodeSqliteDb } from "../testing/node-sqlite-db.js";
import type { SqlValue, Statement } from "../types.js";

const reject = (kind: string, message: string) => Promise.reject({ kind, message });

export function createTauriIpcDouble(): Invoke {
  const db = createNodeSqliteDb();
  const blobs = new Map<string, Uint8Array>();

  return async (command, rawArgs) => {
    if (command === "blob_put") {
      if (!(rawArgs instanceof Uint8Array)) return reject("invalid", "expected a raw body");
      const hash = await blobHashOf(rawArgs);
      blobs.set(hash, new Uint8Array(rawArgs));
      return hash;
    }
    const args = JSON.parse(JSON.stringify(rawArgs ?? {})) as {
      sql: string;
      params: SqlValue[];
      steps: { sql: string; params: SqlValue[] | null }[];
      hash: string;
    };
    if (command.startsWith("blob_") && !isBlobHash(args.hash)) {
      return reject("invalid", `bad hash ${args.hash}`);
    }
    try {
      switch (command) {
        case "db_query":
          return JSON.parse(JSON.stringify(await db.query(args.sql, args.params)));
        case "db_run":
          return await db.run(args.sql, args.params);
        case "db_transaction":
          return await db.transaction(
            args.steps.map(
              (step): Statement =>
                step.params === null ? { sql: step.sql } : { sql: step.sql, params: step.params },
            ),
          );
        case "blob_get": {
          const bytes = blobs.get(args.hash);
          return bytes ? new Uint8Array(bytes).buffer : reject("not_found", args.hash);
        }
        case "blob_has":
          return blobs.has(args.hash);
        case "blob_delete":
          blobs.delete(args.hash);
          return null;
        default:
          return reject("invalid", `unknown command ${command}`);
      }
    } catch (error) {
      return reject("sql", error instanceof Error ? error.message : String(error));
    }
  };
}
