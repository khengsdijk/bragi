import { assertBlobHash, blobFileName, blobHashOf } from "../blob-hash.js";
import type { BlobCache, BlobHash } from "../types.js";

/** `FileSystemSyncAccessHandle`, which TypeScript only declares in the WebWorker lib. */
interface SyncAccessHandle {
  truncate(size: number): void;
  write(buffer: Uint8Array, options: { at: number }): number;
  flush(): void;
  close(): void;
}

interface SyncCapableFileHandle extends FileSystemFileHandle {
  createSyncAccessHandle(): Promise<SyncAccessHandle>;
}

const isNotFound = (error: unknown) =>
  error instanceof DOMException && (error.name === "NotFoundError" || error.name === "TypeError");

/**
 * The browser BlobCache: one OPFS file per blob, named by its hash, in
 * `/blobs`. **Runs in a worker only** — it writes through sync access handles,
 * the one OPFS write path every engine (including WebKit) supports.
 *
 * Reads verify the hash; a blob that fails (a torn write, a bit flip) is
 * removed and reported absent, so the cache heals instead of serving bad bytes.
 */
export async function createOpfsBlobCache(directoryName = "blobs"): Promise<BlobCache> {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(directoryName, { create: true });

  const fileHandle = async (hash: BlobHash): Promise<FileSystemFileHandle | null> => {
    try {
      return await dir.getFileHandle(blobFileName(hash));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  };

  const read = async (hash: BlobHash): Promise<Uint8Array | null> => {
    const handle = await fileHandle(hash);
    if (!handle) return null;
    const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
    if ((await blobHashOf(bytes)) === hash) return bytes;
    await dir.removeEntry(blobFileName(hash)).catch(() => undefined);
    return null;
  };

  return {
    async put(bytes) {
      const hash = await blobHashOf(bytes);
      if ((await read(hash)) !== null) return hash;
      const handle = (await dir.getFileHandle(blobFileName(hash), {
        create: true,
      })) as SyncCapableFileHandle;
      const access = await handle.createSyncAccessHandle();
      try {
        access.truncate(0);
        let written = 0;
        while (written < bytes.byteLength) {
          written += access.write(bytes.subarray(written), { at: written });
        }
        access.flush();
      } finally {
        access.close();
      }
      return hash;
    },
    async get(hash) {
      assertBlobHash(hash);
      return read(hash);
    },
    async has(hash) {
      assertBlobHash(hash);
      return (await fileHandle(hash)) !== null;
    },
    async delete(hash) {
      assertBlobHash(hash);
      try {
        await dir.removeEntry(blobFileName(hash));
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    },
  };
}
