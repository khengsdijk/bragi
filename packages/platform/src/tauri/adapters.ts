/**
 * Desktop adapters: thin, typed wrappers over the Tauri commands in
 * apps/desktop/src-tauri. `invoke` is injected so the same code is tested in
 * Vitest against a double and runs in the webview against the real IPC.
 *
 * Command names and argument shapes here must match `src-tauri/src/commands.rs`.
 */
import { assertBlobHash, isBlobHash } from "../blob-hash.js";
import { closedError, toError } from "../errors.js";
import type { BlobCache, BlobHash, LocalDB, Row, RunResult } from "../types.js";

/** The shape of `@tauri-apps/api/core`'s `invoke`. Args are JSON, or raw bytes as the request body. */
export type Invoke = (
  command: string,
  args?: Record<string, unknown> | Uint8Array,
) => Promise<unknown>;

/** The error payload Rust commands reject with (`CommandError` in commands.rs). */
interface CommandError {
  kind: "sql" | "not_found" | "invalid" | "io";
  message: string;
}

const isCommandError = (value: unknown): value is CommandError =>
  typeof value === "object" && value !== null && "kind" in value && "message" in value;

async function call<T>(
  invoke: Invoke,
  command: string,
  args?: Record<string, unknown> | Uint8Array,
) {
  try {
    return (await invoke(command, args)) as T;
  } catch (cause) {
    throw toError(cause, command);
  }
}

export function createTauriLocalDb(invoke: Invoke): LocalDB {
  let closed = false;
  const live = <T>(work: () => Promise<T>): Promise<T> =>
    closed ? Promise.reject(closedError()) : work();

  return {
    query: (sql, params = []) => live(() => call<Row[]>(invoke, "db_query", { sql, params })),
    run: (sql, params = []) => live(() => call<RunResult>(invoke, "db_run", { sql, params })),
    transaction: (steps) =>
      live(() =>
        call<void>(invoke, "db_transaction", {
          steps: steps.map((step) => ({ sql: step.sql, params: step.params ?? null })),
        }),
      ),
    // The connection belongs to the app process and outlives any one page.
    close: async () => {
      closed = true;
    },
  };
}

const toBytes = (value: unknown): Uint8Array => {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  throw new TypeError("blob_get returned an unexpected payload");
};

export function createTauriBlobCache(invoke: Invoke): BlobCache {
  return {
    async put(bytes) {
      // Raw request body: no JSON number arrays for binary data.
      const hash = await call<string>(invoke, "blob_put", new Uint8Array(bytes));
      if (!isBlobHash(hash)) throw new Error(`blob_put returned a malformed hash: ${hash}`);
      return hash;
    },
    async get(hash: BlobHash) {
      assertBlobHash(hash);
      try {
        return toBytes(await invoke("blob_get", { hash }));
      } catch (cause) {
        if (isCommandError(cause) && cause.kind === "not_found") return null;
        throw toError(cause, "blob_get");
      }
    },
    async has(hash) {
      assertBlobHash(hash);
      return call<boolean>(invoke, "blob_has", { hash });
    },
    async delete(hash) {
      assertBlobHash(hash);
      await call<void>(invoke, "blob_delete", { hash });
    },
  };
}
