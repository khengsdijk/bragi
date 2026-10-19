/**
 * The SHA-256 worker (01 §6 step 1). Kept tiny: it receives an `ArrayBuffer`,
 * hashes it with `crypto.subtle` and posts `{ id, hash }` back. `hash.ts` owns
 * the request bookkeeping and the main-thread fallback.
 */
import type { HashRequest, HashResponse } from "./hash.js";

self.onmessage = async (event: MessageEvent<HashRequest>): Promise<void> => {
  const digest = await crypto.subtle.digest("SHA-256", event.data.bytes);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const response: HashResponse = { id: event.data.id, hash: `sha256:${hex}` };
  (self as unknown as { postMessage(message: HashResponse): void }).postMessage(response);
};
