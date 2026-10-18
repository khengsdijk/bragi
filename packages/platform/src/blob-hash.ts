import type { BlobHash } from "./types.js";

const BLOB_HASH = /^sha256:[0-9a-f]{64}$/;

/** True when `value` is a well-formed `sha256:<64 lowercase hex>` identifier. */
export function isBlobHash(value: string): value is BlobHash {
  return BLOB_HASH.test(value);
}

/**
 * Rejects anything that is not a well-formed blob hash. Adapters call this
 * before a hash is used as a file name, so a hash can never name a path outside
 * the cache.
 */
export function assertBlobHash(value: string): asserts value is BlobHash {
  if (!isBlobHash(value)) {
    throw new TypeError(`Not a blob hash (expected sha256:<64 hex>): ${JSON.stringify(value)}`);
  }
}

/** SHA-256 of the bytes as a {@link BlobHash}. Uses Web Crypto, so it works in pages, workers and Node. */
export async function blobHashOf(bytes: Uint8Array): Promise<BlobHash> {
  // Copy into a fresh ArrayBuffer: `digest` rejects views over SharedArrayBuffer.
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  let hex = "";
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
  return `sha256:${hex}`;
}

/** The hex part of a blob hash, used as the file name inside a cache directory. */
export function blobFileName(hash: BlobHash): string {
  return hash.slice("sha256:".length);
}
