/**
 * The message protocol between the page and the storage worker that owns
 * sqlite-wasm and the OPFS blob directory. Kept separate from both ends so the
 * client and the server are tested against each other over a real
 * `MessageChannel`.
 */
import { assertBlobHash } from "../blob-hash.js";
import { toError } from "../errors.js";
import type { BlobCache, LocalDB, SqlValue, Statement } from "../types.js";

export type StorageCall =
  | { op: "db.query"; sql: string; params: SqlValue[] }
  | { op: "db.run"; sql: string; params: SqlValue[] }
  | { op: "db.transaction"; steps: Statement[] }
  | { op: "db.close" }
  | { op: "blob.put"; bytes: Uint8Array }
  | { op: "blob.get"; hash: string }
  | { op: "blob.has"; hash: string }
  | { op: "blob.delete"; hash: string };

export interface StorageRequest {
  id: number;
  call: StorageCall;
}

export type StorageResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; message: string };

/** Sent once by the worker: storage opened, or why it could not. */
export type StorageReady = { ready: true } | { ready: false; message: string };

/** The subset of `Worker`, `MessagePort` and a worker's global scope both ends need. */
export interface MessageEndpoint {
  postMessage(message: unknown, transfer: Transferable[]): void;
  onmessage: ((event: MessageEvent) => void) | null;
}

export interface StorageBackend {
  readonly db: LocalDB;
  readonly blobs: BlobCache;
}

async function dispatch(backend: StorageBackend, call: StorageCall): Promise<unknown> {
  switch (call.op) {
    case "db.query":
      return backend.db.query(call.sql, call.params);
    case "db.run":
      return backend.db.run(call.sql, call.params);
    case "db.transaction":
      return backend.db.transaction(call.steps);
    case "db.close":
      return backend.db.close();
    case "blob.put":
      return backend.blobs.put(call.bytes);
    case "blob.get":
      assertBlobHash(call.hash);
      return backend.blobs.get(call.hash);
    case "blob.has":
      assertBlobHash(call.hash);
      return backend.blobs.has(call.hash);
    case "blob.delete":
      assertBlobHash(call.hash);
      return backend.blobs.delete(call.hash);
  }
}

/**
 * Worker side: waits for the backend to open, reports readiness, then answers
 * requests. Calls are processed strictly in arrival order, so a `db.run`
 * followed by a `db.query` from the same page always observes the write.
 */
export function serveStorage(endpoint: MessageEndpoint, opening: Promise<StorageBackend>): void {
  let queue: Promise<unknown> = Promise.resolve();
  let backend: StorageBackend | undefined;

  opening.then(
    (opened) => {
      backend = opened;
      endpoint.postMessage({ ready: true } satisfies StorageReady, []);
    },
    (cause: unknown) => {
      const { message } = toError(cause, "Storage");
      endpoint.postMessage({ ready: false, message } satisfies StorageReady, []);
    },
  );

  endpoint.onmessage = (event: MessageEvent) => {
    const { id, call } = event.data as StorageRequest;
    queue = queue.then(async () => {
      try {
        if (!backend) throw new Error("Storage is not open");
        const value = await dispatch(backend, call);
        const transfer = value instanceof Uint8Array ? [value.buffer] : [];
        endpoint.postMessage({ id, ok: true, value } satisfies StorageResponse, transfer);
      } catch (cause) {
        const { message } = toError(cause, call.op);
        endpoint.postMessage({ id, ok: false, message } satisfies StorageResponse, []);
      }
    });
  };
}

export interface StorageClient {
  readonly localDb: LocalDB;
  readonly blobCache: BlobCache;
}

/**
 * Page side: resolves once the worker reports that storage is open, with
 * LocalDB and BlobCache proxies that forward every call to it.
 */
export function connectStorage(endpoint: MessageEndpoint): Promise<StorageClient> {
  let nextId = 1;
  let closed = false;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  const call = (request: StorageCall, transfer: Transferable[] = []): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      endpoint.postMessage({ id, call: request } satisfies StorageRequest, transfer);
    });

  const db = <T>(request: StorageCall): Promise<T> =>
    closed ? Promise.reject(new Error("LocalDB is closed")) : (call(request) as Promise<T>);

  const blob = <T>(hash: string, request: StorageCall): Promise<T> => {
    try {
      assertBlobHash(hash);
    } catch (error) {
      return Promise.reject(error);
    }
    return call(request) as Promise<T>;
  };

  const client: StorageClient = {
    localDb: {
      query: (sql, params = []) => db({ op: "db.query", sql, params: [...params] }),
      run: (sql, params = []) => db({ op: "db.run", sql, params: [...params] }),
      transaction: (steps) => db({ op: "db.transaction", steps: [...steps] }),
      close: async () => {
        if (closed) return;
        await call({ op: "db.close" });
        closed = true;
      },
    },
    blobCache: {
      put: async (bytes) => {
        // Copy, then transfer the copy: the caller keeps its buffer.
        const copy = new Uint8Array(bytes);
        return (await call({ op: "blob.put", bytes: copy }, [copy.buffer])) as `sha256:${string}`;
      },
      get: (hash) => blob(hash, { op: "blob.get", hash }),
      has: (hash) => blob(hash, { op: "blob.has", hash }),
      delete: (hash) => blob(hash, { op: "blob.delete", hash }),
    },
  };

  return new Promise((resolveReady, rejectReady) => {
    endpoint.onmessage = (event: MessageEvent) => {
      const data = event.data as StorageResponse | StorageReady;
      if ("ready" in data) {
        if (data.ready) resolveReady(client);
        else rejectReady(new Error(`Local storage could not open: ${data.message}`));
        return;
      }
      const waiter = pending.get(data.id);
      if (!waiter) return;
      pending.delete(data.id);
      if (data.ok) waiter.resolve(data.value);
      else waiter.reject(new Error(data.message));
    };
  });
}
