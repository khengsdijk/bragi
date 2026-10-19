import { describe, expect, it } from "vitest";

import { createHasher, sha256Hex } from "../api/hash.js";

describe("sha256Hex", () => {
  it('matches the known SHA-256 of empty input and of "abc"', async () => {
    expect(await sha256Hex(new Uint8Array())).toBe(
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("createHasher", () => {
  it("falls back to the main thread when there is no worker", async () => {
    const hasher = createHasher(null);
    expect(await hasher.hash(new TextEncoder().encode("abc"))).toBe(
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    hasher.dispose();
  });
});
