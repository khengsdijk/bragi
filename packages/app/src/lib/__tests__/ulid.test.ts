import { describe, expect, it } from "vitest";

import { ulid } from "../ulid.js";

describe("ulid", () => {
  it("encodes the timestamp in the first 10 Crockford base32 characters", () => {
    // 1_469_918_176_385 ms is the ULID spec's example timestamp → 01ARYZ6S41.
    const id = ulid(1_469_918_176_385, () => new Uint8Array(10));
    expect(id).toBe("01ARYZ6S410000000000000000");
  });

  it("is 26 characters of Crockford base32 and sorts by time", () => {
    const early = ulid(1_000);
    const late = ulid(2_000);
    expect(early).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(early < late).toBe(true);
  });

  it("uses all 80 random bits", () => {
    const id = ulid(0, () => new Uint8Array(10).fill(0xff));
    expect(id).toBe("0000000000ZZZZZZZZZZZZZZZZ");
  });
});
