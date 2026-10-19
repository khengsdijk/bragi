import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { renderFixture } from "../fixture-song.mjs";

describe("fixture-song", () => {
  it("writes a 48 kHz 16-bit stereo WAV of the asked length", () => {
    const { buffer, sampleRate, channels, seconds } = renderFixture({ seconds: 1 });
    expect(sampleRate).toBe(48_000);
    expect(channels).toBe(2);
    expect(seconds).toBe(1);
    expect(buffer.toString("ascii", 0, 4)).toBe("RIFF");
    expect(buffer.toString("ascii", 8, 12)).toBe("WAVE");
    expect(buffer.readUInt16LE(22)).toBe(2);
    expect(buffer.readUInt32LE(24)).toBe(48_000);
    expect(buffer.readUInt16LE(34)).toBe(16);
    // 44-byte header + 1 s of interleaved 16-bit stereo.
    expect(buffer.length).toBe(44 + 48_000 * 2 * 2);
  });

  it("is deterministic", () => {
    /** @param {Buffer} buffer */
    const digest = (buffer) => createHash("sha256").update(buffer).digest("hex");
    expect(digest(renderFixture({ seconds: 2 }).buffer)).toBe(
      digest(renderFixture({ seconds: 2 }).buffer),
    );
  });

  it("produces audible, non-clipping signal", () => {
    const { buffer } = renderFixture({ seconds: 2 });
    let peak = 0;
    for (let offset = 44; offset < buffer.length; offset += 2) {
      peak = Math.max(peak, Math.abs(buffer.readInt16LE(offset)));
    }
    expect(peak).toBeGreaterThan(1000);
    expect(peak).toBeLessThanOrEqual(32_767);
  });
});
