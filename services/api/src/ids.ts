/** IDs and content hashes (specs/02-song-model.md §2.1, 05 §6). */
import { createHash } from "node:crypto";

import { ulid } from "ulid";

/** `job_` + ULID (02 §2.1, 05 §3). */
export function newJobId(): string {
  return `job_${ulid()}`;
}

/** `prj_` + ULID. */
export function newProjectId(): string {
  return `prj_${ulid()}`;
}

/** `lib_` + ULID. */
export function newLibraryItemId(): string {
  return `lib_${ulid()}`;
}

/** A plan id, `pln_` + ULID. */
export function newPlanId(): string {
  return `pln_${ulid()}`;
}

/** A `usage_ledger` id, `led_` + ULID. */
export function newLedgerId(): string {
  return `led_${ulid()}`;
}

/** A local user id, `usr_` + ULID (Better Auth stores whatever string it is given). */
export function newUserId(): string {
  return `usr_${ulid()}`;
}

/** `sha256:<lowercase hex>` for a byte payload (05 §6). */
export function hashBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export const ASSET_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** True when `hash` is a well-formed content address. */
export function isAssetHash(hash: string): boolean {
  return ASSET_HASH_PATTERN.test(hash);
}

/** The hex digest of a `sha256:…` content address. */
export function hashHex(hash: string): string {
  return hash.slice("sha256:".length);
}
