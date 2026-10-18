import { assertBlobHash, blobHashOf } from "./blob-hash.js";
import type { BlobCache, BlobHash, FileAccess, PickedFile } from "./types.js";

/** A BlobCache held in a `Map`. Used by tests and by the in-memory platform. */
export function createMemoryBlobCache(): BlobCache {
  const blobs = new Map<BlobHash, Uint8Array>();
  return {
    async put(bytes) {
      const hash = await blobHashOf(bytes);
      if (!blobs.has(hash)) blobs.set(hash, new Uint8Array(bytes));
      return hash;
    },
    async get(hash) {
      assertBlobHash(hash);
      const bytes = blobs.get(hash);
      return bytes ? new Uint8Array(bytes) : null;
    },
    async has(hash) {
      assertBlobHash(hash);
      return blobs.has(hash);
    },
    async delete(hash) {
      assertBlobHash(hash);
      blobs.delete(hash);
    },
  };
}

/** A FileAccess that hands out a scripted list of files, for tests. */
export function createScriptedFileAccess(
  files: readonly { name: string; bytes: Uint8Array }[],
): FileAccess {
  return {
    async pickFiles(): Promise<PickedFile[]> {
      return files.map(({ name, bytes }) => ({
        name,
        size: bytes.byteLength,
        bytes: async () => new Uint8Array(bytes),
      }));
    },
  };
}
