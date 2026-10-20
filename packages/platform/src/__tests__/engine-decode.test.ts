/**
 * The decoder worker's one job: compressed bytes in, PCM at the engine's rate out, never on the
 * audio thread (specs/03-audio-engine.md §3.1). This runs the real `bragi-engine` wasm in Node.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import type { AssetHash } from "../engine/types.js";
import { decodeAsset, initSync } from "../web/decode.js";

const HASH = `sha256:${"0".repeat(64)}` as AssetHash;

/** A 16-bit PCM WAV: `frames` frames of a quiet ramp, `channels` channels. */
function wav(channels: 1 | 2, sampleRate: number, frames: number): Uint8Array {
  const data = new Uint8Array(frames * channels * 2);
  const view = new DataView(data.buffer);
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      view.setInt16((frame * channels + channel) * 2, (frame + channel) * 1000, true);
    }
  }
  const header = new Uint8Array(44);
  const headerView = new DataView(header.buffer);
  const ascii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1)
      header[offset + index] = text.charCodeAt(index);
  };
  ascii(0, "RIFF");
  headerView.setUint32(4, 36 + data.length, true);
  ascii(8, "WAVEfmt ");
  headerView.setUint32(16, 16, true); // fmt chunk size
  headerView.setUint16(20, 1, true); // PCM
  headerView.setUint16(22, channels, true);
  headerView.setUint32(24, sampleRate, true);
  headerView.setUint32(28, sampleRate * channels * 2, true); // byte rate
  headerView.setUint16(32, channels * 2, true); // block align
  headerView.setUint16(34, 16, true); // bits
  ascii(36, "data");
  headerView.setUint32(40, data.length, true);
  const out = new Uint8Array(header.length + data.length);
  out.set(header);
  out.set(data, header.length);
  return out;
}

beforeAll(() => {
  const wasm = fileURLToPath(
    new URL("../../../../crates/bragi-engine-wasm/pkg/bragi_engine_wasm_bg.wasm", import.meta.url),
  );
  initSync({ module: new Uint8Array(readFileSync(wasm)) });
});

describe("the decoder worker", () => {
  it("decodes a stereo WAV at the engine rate", () => {
    const pcm = decodeAsset({ hash: HASH, bytes: wav(2, 48_000, 4), mime: "audio/wav" });
    expect(pcm.hash).toBe(HASH);
    expect(pcm.channels).toBe(2);
    expect(pcm.sampleRate).toBe(48_000);
    expect(pcm.samples).toBeInstanceOf(Float32Array);
    expect(pcm.samples.length / pcm.channels).toBe(4);
    // 1000 / 32768 is the first right-channel sample.
    expect(pcm.samples[1]).toBeCloseTo(1000 / 32768, 5);
  });

  it("resamples a non-conforming asset to 48 kHz", () => {
    const pcm = decodeAsset({ hash: HASH, bytes: wav(1, 24_000, 4), mime: "audio/wav" });
    expect(pcm.channels).toBe(1);
    expect(pcm.sampleRate).toBe(48_000);
    expect(pcm.samples.length / pcm.channels).toBe(8);
  });

  it("rejects bytes that are not audio", () => {
    expect(() =>
      decodeAsset({ hash: HASH, bytes: new Uint8Array([1, 2, 3]), mime: "audio/wav" }),
    ).toThrow(/decoding failed/);
  });
});
