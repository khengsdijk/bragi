/**
 * SHA-256 of an upload (01 §6 step 1, 05 §6).
 *
 * Hashing a 4-minute FLAC (~40 MB) on the main thread would stall the drop UI,
 * so the app uses a Web Worker. `createHasher` falls back to the main thread
 * when workers are unavailable (tests, an unusual host), which keeps the flow
 * controller identical everywhere.
 */
import type { BlobHash } from "@bragi/platform";

/** `sha256:` + lowercase hex. */
function toHash(digest: ArrayBuffer): BlobHash {
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}

/** SHA-256 on the current thread. `crypto.subtle` exists in browsers and Node 20+. */
export async function sha256Hex(bytes: Uint8Array): Promise<BlobHash> {
  const copy = bytes.slice();
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return toHash(digest);
}

export interface Hasher {
  /** Hashes bytes (a `Blob` is read first). */
  hash(bytes: Uint8Array | Blob): Promise<BlobHash>;
  dispose(): void;
}

// The worker's message; kept in sync with `hash.worker.ts`.
export interface HashRequest {
  readonly id: number;
  readonly bytes: ArrayBuffer;
}
export interface HashResponse {
  readonly id: number;
  readonly hash: BlobHash;
}

const workerFactory = (): Worker =>
  new Worker(new URL("./hash.worker.js", import.meta.url), {
    type: "module",
    name: "bragi-hash",
  });

/**
 * A hasher backed by a worker, with a transparent main-thread fallback.
 *
 * @param factory injectable for tests; omit to spawn the real worker
 */
export function createHasher(factory: (() => Worker) | null = workerFactory): Hasher {
  let worker: Worker | null = null;
  if (factory !== null) {
    try {
      worker = factory();
    } catch {
      worker = null;
    }
  }

  const pending = new Map<
    number,
    { resolve: (hash: BlobHash) => void; reject: (e: Error) => void }
  >();
  let nextId = 1;

  if (worker !== null) {
    worker.onmessage = (event: MessageEvent<HashResponse>) => {
      const entry = pending.get(event.data.id);
      if (entry === undefined) return;
      pending.delete(event.data.id);
      entry.resolve(event.data.hash);
    };
    worker.onerror = () => {
      for (const entry of pending.values()) entry.reject(new Error("the hash worker failed"));
      pending.clear();
    };
  }

  return {
    async hash(input) {
      const bytes = input instanceof Blob ? new Uint8Array(await input.arrayBuffer()) : input;
      const target = worker;
      if (target === null) return sha256Hex(bytes);
      const copy = bytes.slice();
      const id = nextId++;
      return new Promise<BlobHash>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        const request: HashRequest = { id, bytes: copy.buffer };
        target.postMessage(request, [copy.buffer]);
      });
    },
    dispose() {
      worker?.terminate();
      worker = null;
      pending.clear();
    },
  };
}
