/**
 * The engine seam: the wire codec, the asset helpers and the two `EngineHost`
 * adapters driven through fakes (specs/03-audio-engine.md §3.3).
 */
import { describe, expect, it, vi } from "vitest";

import {
  bytesToFloat32,
  decodeExportFrame,
  decodeStateWords,
  encodeTransport,
  float32ToBytes,
  floatToWord,
  packCommand,
  pyramidLevel,
  STATE_HEADER_WORDS,
  unpackCommand,
} from "../engine/codec.js";
import type { EngineState } from "../engine/types.js";
import { createTauriEngineHost } from "../tauri/engine.js";
import {
  collectAssetHashes,
  createWasmEngineHost,
  type EngineOfflineBridge,
  type EnginePlaybackBridge,
  guessMime,
  stateWordCount,
} from "../web/engine.js";

describe("the ring codec", () => {
  it("round-trips commands", () => {
    const word = packCommand(3, 1_234_567_890);
    expect(unpackCommand(word)).toEqual({ opcode: 3, payload: 1_234_567_890n });
  });

  it("keeps the opcode in the high byte", () => {
    expect(Number(packCommand(255, 1) >> 56n)).toBe(255);
  });

  it("encodes transport commands", () => {
    expect(encodeTransport({ kind: "play" })).toHaveLength(1);
    expect(encodeTransport({ kind: "seek", sample: 42 })[0]).toBe(packCommand(3, 42));
    const loop = encodeTransport({ kind: "loop", start: 10, end: 20 });
    expect(loop[0]).toBe(packCommand(4, 10));
    expect(loop[1]).toBe(packCommand(7, 20));
    expect(encodeTransport({ kind: "loop", start: 0, end: null })).toEqual([packCommand(5)]);
    expect(encodeTransport({ kind: "audition", on: true })).toEqual([packCommand(6, 1)]);
  });
});

describe("the state block", () => {
  it("decodes transport, counters and meters", () => {
    const words = new Uint32Array(stateWordCount(2));
    words[0] = 3; // looping
    words[1] = 1; // auditioning
    words[2] = 0x1234;
    words[3] = 0x1;
    words[4] = 7;
    words[6] = 9;
    words[STATE_HEADER_WORDS] = floatToWord(0.5);
    words[STATE_HEADER_WORDS + 1] = floatToWord(0.25);
    words[STATE_HEADER_WORDS + 4] = floatToWord(0.75);
    words[STATE_HEADER_WORDS + 5] = floatToWord(0.125);

    const state = decodeStateWords(words);
    expect(state.transport).toBe("looping");
    expect(state.auditioning).toBe(true);
    expect(state.playhead).toBe(0x1_0000_1234);
    expect(state.underruns).toBe(7);
    expect(state.planVersion).toBe(9);
    expect(state.tracks).toEqual([
      { peak: 0.5, rms: 0.25 },
      { peak: 0, rms: 0 },
    ]);
    expect(state.master).toEqual({ peak: 0.75, rms: 0.125 });
  });

  it("tolerates a short block", () => {
    const state = decodeStateWords(new Uint32Array(3));
    expect(state.transport).toBe("stopped");
    expect(state.tracks).toEqual([]);
  });

  it("round-trips f32 words", () => {
    expect(bytesToFloat32(float32ToBytes(new Float32Array([0.5, -0.25])))).toEqual(
      new Float32Array([0.5, -0.25]),
    );
  });
});

describe("asset helpers", () => {
  it("collects every asset hash in a document", () => {
    const hash = `sha256:${"a".repeat(64)}`;
    const other = `sha256:${"b".repeat(64)}`;
    const doc = {
      sources: [{ workingAsset: hash }],
      arrangement: { sections: [{ lanes: { t: { clips: [{ asset: other }, { asset: hash }] } } }] },
    };
    expect(collectAssetHashes(doc).sort()).toEqual([hash, other].sort());
  });

  it("guesses mime types from magic bytes", () => {
    const riff = new Uint8Array(12);
    riff.set([0x52, 0x49, 0x46, 0x46], 0);
    riff.set([0x57, 0x41, 0x56, 0x45], 8);
    expect(guessMime(riff)).toBe("audio/wav");
    expect(guessMime(new Uint8Array([0x66, 0x4c, 0x61, 0x43]))).toBe("audio/flac");
    expect(guessMime(new Uint8Array([0x4f, 0x67, 0x67, 0x53]))).toBe("audio/ogg");
    expect(guessMime(new Uint8Array([1, 2, 3]))).toBe("application/octet-stream");
  });
});

const hash = `sha256:${"0".repeat(64)}` as const;

/** A one-level pyramid at 256 samples per bin, as `bragi-engine` writes it. */
function pyramidBytes(): Uint8Array {
  const bytes = new Uint8Array(24 + 12 + 8);
  bytes.set([0x42, 0x52, 0x47, 0x50], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 1, true);
  view.setUint32(8, 1, true);
  view.setBigUint64(12, 256n, true);
  view.setUint32(20, 1, true);
  view.setUint32(24, 256, true);
  view.setBigUint64(28, 1n, true);
  view.setFloat32(36, -1, true);
  view.setFloat32(40, 1, true);
  return bytes;
}

/** Builds an export frame the way `bragi_engine::export::ExportResult::to_frame` does. */
function exportFrame(files: { name: string; bytes: number[]; frames: number }[]): Uint8Array {
  const header = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      channels: 2,
      sampleRate: 48000,
      frames: Math.max(0, ...files.map((file) => file.frames)),
      files: files.map((file) => ({
        name: file.name,
        length: file.bytes.length,
        frames: file.frames,
      })),
    }),
  );
  const payload = files.flatMap((file) => file.bytes);
  const out = new Uint8Array(8 + header.length + payload.length);
  out.set([0x42, 0x58, 0x50, 0x54], 0); // BXPT
  new DataView(out.buffer).setUint32(4, header.length, true);
  out.set(header, 8);
  out.set(payload, 8 + header.length);
  return out;
}

function fakePlayback() {
  const sent: bigint[][] = [];
  const loaded: unknown[] = [];
  const bridge: EnginePlaybackBridge = {
    state: new Uint32Array(stateWordCount(1)),
    send(words) {
      sent.push([...words]);
    },
    async load(doc) {
      loaded.push(doc);
    },
    applyDelta() {},
    async dispose() {},
  };
  return { bridge, sent, loaded };
}

function fakeOffline(): EngineOfflineBridge {
  return {
    async render(job) {
      return {
        channels: 2,
        sampleRate: 48000,
        format:
          job.kind === "mixdown" || job.kind === "stems"
            ? job.format
            : { container: "wav", bits: 32 },
        files: [{ name: "Song.wav", bytes: new Uint8Array(0), frames: 0 }],
        frames: 0,
      };
    },
    async peaks() {
      return new Float32Array(4);
    },
    async spectrogram() {
      return new Uint8Array(0);
    },
    async dispose() {},
  };
}

describe("the wasm engine host", () => {
  it("forwards commands, loads documents and streams state", async () => {
    const playback = fakePlayback();
    const states: EngineState[] = [];
    const frames: (() => void)[] = [];
    const host = createWasmEngineHost({
      playback: playback.bridge,
      offline: fakeOffline(),
      schedule: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelSchedule: () => {},
    });

    await host.init({ sampleRate: 48000 });
    await host.loadDocument({ id: "prj_01" });
    expect(playback.loaded).toHaveLength(1);

    host.transport({ kind: "seek", sample: 128 });
    expect(playback.sent.at(-1)).toEqual([packCommand(3, 128)]);

    host.onState((state) => states.push(state));
    playback.bridge.state[0] = 1;
    playback.bridge.state[2] = 480;
    frames.at(-1)?.();
    expect(states.at(-1)?.transport).toBe("playing");
    expect(states.at(-1)?.playhead).toBe(480);

    host.transport({ kind: "play" });
    await host.dispose();
    // OP_LOAD from `loadDocument`, then the seek, then the play.
    expect(playback.sent).toHaveLength(3);
    expect(playback.sent[1]).toEqual([packCommand(3, 128)]);
    expect(playback.sent[2]).toEqual([packCommand(0)]);
  });

  it("emits plan and underrun events", async () => {
    const playback = fakePlayback();
    const events: string[] = [];
    const frames: (() => void)[] = [];
    const host = createWasmEngineHost({
      playback: playback.bridge,
      offline: fakeOffline(),
      schedule: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelSchedule: () => {},
    });
    host.onEvent((event) => events.push(event.kind));
    await host.init({ sampleRate: 48000 });
    playback.bridge.state[6] = 3;
    playback.bridge.state[4] = 2;
    frames.at(-1)?.();
    expect(events).toContain("planCompiled");
    expect(events).toContain("underrun");
    await host.dispose();
  });
});

describe("the tauri engine host", () => {
  it("maps the interface onto the invoke surface", async () => {
    const calls: string[] = [];
    const state: EngineState = {
      transport: "paused",
      playhead: 99,
      auditioning: false,
      planVersion: 4,
      underruns: 0,
      tracks: [{ peak: 0.1, rms: 0.05 }],
      master: { peak: 0.2, rms: 0.1 },
    };
    const invoke = vi.fn(async (command: string, _args?: Record<string, unknown>) => {
      calls.push(command);
      if (command === "engine_init") return { playback: false };
      if (command === "engine_state") return state;
      if (command === "engine_peaks") return pyramidBytes();
      if (command === "engine_render")
        return exportFrame([{ name: "Song.flac", bytes: [1, 2, 3], frames: 7 }]);
      return null;
    });
    const host = await createTauriEngineHost({
      invoke,
      setInterval: () => 1,
      clearInterval: () => {},
    });
    expect(calls).toContain("engine_init");

    const states: EngineState[] = [];
    const events: import("../engine/types.js").EngineEvent[] = [];
    host.onState((value) => states.push(value));
    host.onEvent((event) => events.push(event));
    await host.init({ sampleRate: 48000 });
    await host.loadDocument({ id: "prj_01" });
    host.applyDelta({ requiresFullResync: false });
    host.setPreview({ kind: "trackGain", trackId: "trk_01", db: -3 });
    host.transport({ kind: "play" });
    host.audition({ commitId: "cmt_1", doc: { id: "prj_01" } });
    const rendered = await host.render({
      kind: "mixdown",
      format: { container: "flac", bits: 24 },
    });
    expect(rendered.channels).toBe(2);
    expect(rendered.format).toEqual({ container: "flac", bits: 24 });
    expect(rendered.files.map((file) => file.name)).toEqual(["Song.flac"]);
    expect([...(rendered.files[0]?.bytes ?? [])]).toEqual([1, 2, 3]);
    const peaks = await host.peaks(hash, 256);
    expect([...peaks]).toEqual([-1, 1]);
    await host.dispose();

    for (const command of [
      "engine_load_document",
      "engine_apply_delta",
      "engine_set_preview",
      "engine_transport",
      "engine_render",
      "engine_peaks",
      "engine_dispose",
    ]) {
      expect(calls).toContain(command);
    }
    expect(events.some((event) => event.kind === "error" && event.code === "no-device")).toBe(true);
  });
});

describe("the export frame reader", () => {
  const wav = { container: "wav", bits: 24 } as const;

  it("splits one frame into named files", () => {
    const frame = exportFrame([
      { name: "01-Drums.wav", bytes: [1, 2], frames: 5 },
      { name: "02-Bass.wav", bytes: [3, 4, 5], frames: 5 },
    ]);
    const result = decodeExportFrame(frame, wav);
    expect(result.format).toEqual(wav);
    expect(result.frames).toBe(5);
    expect(result.files.map((file) => file.name)).toEqual(["01-Drums.wav", "02-Bass.wav"]);
    expect([...(result.files[1]?.bytes ?? [])]).toEqual([3, 4, 5]);
  });

  it("reads a frame that is a view into a bigger buffer", () => {
    const frame = exportFrame([{ name: "a.wav", bytes: [9, 8], frames: 1 }]);
    const padded = new Uint8Array(frame.length + 6);
    padded.set(frame, 3);
    const result = decodeExportFrame(padded.subarray(3, 3 + frame.length), wav);
    expect([...(result.files[0]?.bytes ?? [])]).toEqual([9, 8]);
  });

  it("rejects garbage and truncation", () => {
    expect(() => decodeExportFrame(new Uint8Array([1, 2, 3]), wav)).toThrow("not an export frame");
    const frame = exportFrame([{ name: "a.wav", bytes: [1, 2, 3], frames: 1 }]);
    expect(() => decodeExportFrame(frame.subarray(0, frame.length - 1), wav)).toThrow("truncated");
  });
});

describe("the peak pyramid reader", () => {
  it("extracts one level", () => {
    const bytes = new Uint8Array(24 + 12 + 8 * 2);
    bytes.set([0x42, 0x52, 0x47, 0x50], 0); // BRGP
    const view = new DataView(bytes.buffer);
    view.setUint32(4, 1, true); // version
    view.setUint32(8, 1, true); // channels
    view.setBigUint64(12, 2n, true); // frames
    view.setUint32(20, 1, true); // levels
    view.setUint32(24, 256, true); // bin size
    view.setBigUint64(28, 2n, true); // bins
    view.setFloat32(36, -1, true);
    view.setFloat32(40, 1, true);
    view.setFloat32(44, -0.5, true);
    view.setFloat32(48, 0.5, true);
    expect([...pyramidLevel(bytes, 256)]).toEqual([-1, 1, -0.5, 0.5]);
    expect(() => pyramidLevel(bytes, 1024)).toThrow();
  });
});
