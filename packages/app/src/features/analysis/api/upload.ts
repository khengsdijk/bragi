/**
 * One asset upload, shared by the drop flow and the generator (01 §6 step 1–4, 05 §2).
 *
 * ```
 * hash → BlobCache → presigned PUT (unless the bytes are already stored) → complete
 * ```
 *
 * `complete` runs even when the object already existed: that call records this user's ownership
 * of the bytes (`user_assets`), which upload dedupe does not (05 §2). The generated context audio
 * and the analysis uploads therefore follow the same path.
 */
import type { ApiClient } from "@bragi/api-client";
import type { BlobHash, Platform } from "@bragi/platform";

import { sha256Hex } from "./hash.js";

/** The phases the UI can show while an asset travels. */
export type AssetUploadPhase = "hashing" | "checking" | "uploading";

export interface AssetUploadDeps {
  readonly platform: Platform;
  readonly api: ApiClient;
  /** Injected for tests; defaults to `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** Injected for tests; defaults to the main-thread SHA-256. */
  readonly hash?: (bytes: Uint8Array) => Promise<BlobHash>;
}

export interface UploadedAsset {
  readonly hash: BlobHash;
}

/**
 * Uploads `bytes` as an asset and returns its content hash.
 *
 * @param onPhase called as the upload moves on; the hash is `null` until it exists
 * @throws an `Error` when the PUT fails (a presign or complete error is an `ApiClientError`)
 */
export async function uploadAsset(
  deps: AssetUploadDeps,
  bytes: Uint8Array,
  mime: string,
  onPhase?: (phase: AssetUploadPhase, hash: BlobHash | null) => void,
): Promise<UploadedAsset> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const hashBytes = deps.hash ?? sha256Hex;

  onPhase?.("hashing", null);
  const hash = await hashBytes(bytes);
  await deps.platform.blobCache.put(bytes);
  onPhase?.("checking", hash);

  const presign = await deps.api.presign({ hash, bytes: bytes.byteLength, mime });
  if (!presign.exists) {
    onPhase?.("uploading", hash);
    const put = await doFetch(presign.uploadUrl, {
      method: "PUT",
      headers: presign.headers,
      body: bytes as unknown as BodyInit,
    });
    if (!put.ok) throw new Error(`the upload failed (${put.status})`);
  }
  await deps.api.complete(hash, mime);
  return { hash };
}
