/** The BlobCache contract, run against every implementation that can run under Vitest. */
import { beforeEach, describe, expect, it } from "vitest";

import type { BlobCache, BlobHash } from "../../types.js";

const utf8 = (text: string) => new TextEncoder().encode(text);

/** SHA-256("abc"), the FIPS 180-2 test vector. */
const ABC_HASH: BlobHash =
  "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const ABSENT: BlobHash = `sha256:${"0".repeat(64)}`;

export function describeBlobCacheContract(name: string, open: () => Promise<BlobCache>): void {
  describe(`BlobCache contract: ${name}`, () => {
    let cache: BlobCache;

    beforeEach(async () => {
      cache = await open();
    });

    it("names a blob by the SHA-256 of its bytes", async () => {
      expect(await cache.put(utf8("abc"))).toBe(ABC_HASH);
    });

    it("returns the stored bytes", async () => {
      const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
      const hash = await cache.put(bytes);
      expect(await cache.get(hash)).toEqual(bytes);
      expect(await cache.has(hash)).toBe(true);
    });

    it("stores empty blobs", async () => {
      const hash = await cache.put(new Uint8Array());
      expect(await cache.get(hash)).toEqual(new Uint8Array());
    });

    it("treats storing the same bytes twice as a no-op", async () => {
      const first = await cache.put(utf8("abc"));
      const second = await cache.put(utf8("abc"));
      expect(second).toBe(first);
      expect(await cache.get(first)).toEqual(utf8("abc"));
    });

    it("reports absent blobs as null / false", async () => {
      expect(await cache.get(ABSENT)).toBeNull();
      expect(await cache.has(ABSENT)).toBe(false);
    });

    it("deletes, and deleting an absent blob is a no-op", async () => {
      const hash = await cache.put(utf8("abc"));
      await cache.delete(hash);
      expect(await cache.has(hash)).toBe(false);
      expect(await cache.get(hash)).toBeNull();
      await expect(cache.delete(hash)).resolves.toBeUndefined();
    });

    it("rejects malformed hashes instead of using them as names", async () => {
      for (const bad of ["sha256:../../etc/passwd", "sha256:ABC", "md5:00", ""]) {
        await expect(cache.get(bad as BlobHash)).rejects.toBeInstanceOf(Error);
        await expect(cache.has(bad as BlobHash)).rejects.toBeInstanceOf(Error);
        await expect(cache.delete(bad as BlobHash)).rejects.toBeInstanceOf(Error);
      }
    });
  });
}
