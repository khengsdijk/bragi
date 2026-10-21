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
import { CONTEXT_FILE_NAME, renderContext } from "../engine/context.js";
import type { EngineHost, EngineState, RenderJob } from "../engine/types.js";
import { createTauriEngineHost } from "../tauri/engine.js";
import {
  collectAssetHashes,
  createWasmEngineHost,
  type EngineAssetBytes,
  type EngineOfflineBridge,
  type EnginePlaybackBridge,
  guessMime,
  OP_AUDITION_SLOT,
  OP_RELEASE_SLOT,
  resizeStateBlock,
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

  it("leaves the analysis result blobs (JSON) out: the decoder must only see audio", () => {
    const audio = `sha256:${"a".repeat(64)}`;
    const json = `sha256:${"b".repeat(64)}`;
    const doc = {
      sources: [{ workingAsset: audio }],
      analyses: { src_1: { blobs: { rhythm: json }, stems: { vocals: audio } } },
    };
    expect(collectAssetHashes(doc as never)).toEqual([audio]);
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
  const loaded: { doc: unknown; assets: readonly unknown[] }[] = [];
  const warmed: { slot: number; doc: unknown; assets: readonly { hash: string }[] }[] = [];
  const bridge: EnginePlaybackBridge = {
    state: new Uint32Array(stateWordCount(1)),
    send(words) {
      sent.push([...words]);
    },
    async load(doc, assets) {
      loaded.push({ doc, assets });
    },
    applyDelta() {},
    async warm(slot, doc, assets) {
      warmed.push({ slot, doc, assets });
    },
    async dispose() {},
  };
  return { bridge, sent, loaded, warmed };
}

function fakeOffline(): EngineOfflineBridge {
  return {
    async decode(assets) {
      return assets.map((asset) => ({
        hash: asset.hash,
        samples: new Float32Array([0, 0]),
        channels: 2,
        sampleRate: 48000,
      }));
    },
    async load() {},
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

  it("renders a context range to WAV bytes", async () => {
    const playback = fakePlayback();
    const jobs: RenderJob[] = [];
    const host = createWasmEngineHost({
      playback: playback.bridge,
      offline: {
        ...fakeOffline(),
        async render(job) {
          jobs.push(job);
          return {
            channels: 2,
            sampleRate: 48000,
            format: { container: "wav", bits: 32 },
            frames: 24_000,
            files: [
              {
                name: CONTEXT_FILE_NAME,
                bytes: new Uint8Array([0x52, 0x49]),
                frames: 24_000,
              },
            ],
          };
        },
      },
      schedule: () => 1,
      cancelSchedule: () => {},
    });
    const doc = { arrangement: { sections: [{ lengthTicks: 3840 }] } };
    const bytes = await renderContext(host, doc, { startTick: 0, endTick: 960 }, ["trk_01"]);
    expect([...bytes]).toEqual([0x52, 0x49]);
    expect(jobs).toEqual([
      { kind: "context", range: { startTick: 0, endTick: 960 }, tracks: ["trk_01"] },
    ]);
    await host.dispose();
  });

  it("loads the committed document into the offline engine before a render, once", async () => {
    const playback = fakePlayback();
    const first = `sha256:${"a".repeat(64)}` as const;
    const second = `sha256:${"b".repeat(64)}` as const;
    const steps: string[] = [];
    const offline: EngineOfflineBridge = {
      ...fakeOffline(),
      async load(doc, assets) {
        steps.push(
          `load ${JSON.stringify(doc)} [${assets.map((asset) => asset.hash[7]).join("")}]`,
        );
      },
      async render(job) {
        steps.push(`render ${job.kind}`);
        return fakeOffline().render(job);
      },
    };
    const host = createWasmEngineHost({
      playback: playback.bridge,
      offline,
      assets: {
        async fetch(hashes) {
          return hashes.map(
            (hash): EngineAssetBytes => ({ hash, bytes: new Uint8Array([1]), mime: "audio/wav" }),
          );
        },
      },
      schedule: () => 1,
      cancelSchedule: () => {},
    });
    const job: RenderJob = {
      kind: "context",
      range: { startTick: 0, endTick: 960 },
      tracks: "all",
    };

    const doc = { sources: [{ workingAsset: first }], tracks: [] };
    await host.loadDocument(doc);
    // Opening a song does not touch the offline engine.
    expect(steps).toEqual([]);
    await host.render(job);
    await host.render(job);
    expect(steps).toEqual([`load ${JSON.stringify(doc)} [a]`, "render context", "render context"]);

    // A new document reloads it, sending only the asset the offline engine lacks.
    steps.length = 0;
    const next = { sources: [{ workingAsset: first }, { workingAsset: second }], tracks: [] };
    await host.loadDocument(next);
    await Promise.all([host.render(job), host.render(job)]);
    expect(steps).toEqual([`load ${JSON.stringify(next)} [b]`, "render context", "render context"]);
    await host.dispose();
  });

  it("decodes and sends each asset once across structural reloads", async () => {
    const playback = fakePlayback();
    const first = `sha256:${"a".repeat(64)}` as const;
    const second = `sha256:${"b".repeat(64)}` as const;
    const fetched: string[][] = [];
    const decoded: string[][] = [];
    const offline: EngineOfflineBridge = {
      ...fakeOffline(),
      async decode(assets) {
        decoded.push(assets.map((asset) => asset.hash));
        return assets.map((asset) => ({
          hash: asset.hash,
          samples: new Float32Array([0, 0]),
          channels: 2,
          sampleRate: 48000,
        }));
      },
    };
    const host = createWasmEngineHost({
      playback: playback.bridge,
      offline,
      assets: {
        async fetch(hashes) {
          fetched.push([...hashes]);
          return hashes.map(
            (hash): EngineAssetBytes => ({ hash, bytes: new Uint8Array([1]), mime: "audio/wav" }),
          );
        },
      },
      schedule: () => 1,
      cancelSchedule: () => {},
    });
    await host.loadDocument({ sources: [{ workingAsset: first }] });
    await host.loadDocument({ sources: [{ workingAsset: first }] });
    // A structural reload with no new assets does not even fetch, let alone decode or send.
    expect(fetched).toEqual([[first]]);
    expect(decoded).toEqual([[first]]);
    expect(playback.loaded.map((entry) => entry.assets)).toHaveLength(2);
    expect(playback.loaded[0]?.assets).toHaveLength(1);
    expect(playback.loaded[1]?.assets).toHaveLength(0);

    // A new stem arrives: only that hash goes across.
    await host.loadDocument({
      sources: [{ workingAsset: first }],
      arrangement: { sections: [{ lanes: { t: { clips: [{ asset: second }] } } }] },
    });
    expect(fetched[1]).toEqual([second]);
    expect(decoded[1]).toEqual([second]);
    expect(playback.loaded[2]?.assets).toHaveLength(1);
    await host.dispose();
  });

  it("warms candidates with only the assets the worklet does not hold, and switches by slot", async () => {
    const playback = fakePlayback();
    const head = `sha256:${"a".repeat(64)}` as const;
    const take = `sha256:${"c".repeat(64)}` as const;
    const decoded: string[][] = [];
    const host = createWasmEngineHost({
      playback: playback.bridge,
      offline: {
        ...fakeOffline(),
        async decode(assets) {
          decoded.push(assets.map((asset) => asset.hash));
          return fakeOffline().decode(assets);
        },
      },
      assets: {
        async fetch(hashes) {
          return hashes.map(
            (hash): EngineAssetBytes => ({ hash, bytes: new Uint8Array([1]), mime: "audio/wav" }),
          );
        },
      },
      schedule: () => 1,
      cancelSchedule: () => {},
    });
    await host.loadDocument({ sources: [{ workingAsset: head }] });
    const candidate = {
      sources: [{ workingAsset: head }],
      arrangement: { sections: [{ lanes: { t: { clips: [{ asset: take }] } } }] },
    };
    await host.warm(1, candidate);
    // Two candidates that share the new take: it crosses once, with the first.
    await host.warm(2, candidate);
    expect(playback.warmed.map((entry) => entry.slot)).toEqual([1, 2]);
    expect(playback.warmed[0]?.assets.map((asset) => asset.hash)).toEqual([take]);
    expect(playback.warmed[1]?.assets).toHaveLength(0);
    expect(decoded).toEqual([[head], [take]]);

    host.audition(2);
    host.audition(0);
    host.release(1);
    expect(playback.sent.slice(-3)).toEqual([
      [packCommand(OP_AUDITION_SLOT, 2)],
      [packCommand(OP_AUDITION_SLOT, 0)],
      [packCommand(OP_RELEASE_SLOT, 1)],
    ]);
    await host.dispose();
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
    const renderJobs: unknown[] = [];
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      calls.push(command);
      if (command === "engine_init") return { playback: false };
      if (command === "engine_state") return state;
      if (command === "engine_peaks") return pyramidBytes();
      if (command === "engine_render") {
        const job = args?.job as { kind?: string } | undefined;
        renderJobs.push(job);
        return job?.kind === "context"
          ? exportFrame([{ name: CONTEXT_FILE_NAME, bytes: [4, 5], frames: 24_000 }])
          : exportFrame([{ name: "Song.flac", bytes: [1, 2, 3], frames: 7 }]);
      }
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
    await host.warm(1, { id: "prj_01" });
    host.audition(1);
    host.release(1);
    const rendered = await host.render({
      kind: "mixdown",
      format: { container: "flac", bits: 24 },
    });
    expect(rendered.channels).toBe(2);
    expect(rendered.format).toEqual({ container: "flac", bits: 24 });
    expect(rendered.files.map((file) => file.name)).toEqual(["Song.flac"]);
    expect([...(rendered.files[0]?.bytes ?? [])]).toEqual([1, 2, 3]);

    const context = await renderContext(
      host,
      { arrangement: { sections: [{ lengthTicks: 1920 }] } },
      { startTick: 0, endTick: 960 },
      "all",
    );
    expect([...context]).toEqual([4, 5]);
    expect(renderJobs.at(-1)).toEqual({
      kind: "context",
      range: { startTick: 0, endTick: 960 },
      tracks: "all",
    });

    const peaks = await host.peaks(hash, 256);
    expect([...peaks]).toEqual([-1, 1]);
    await host.dispose();

    for (const command of [
      "engine_load_document",
      "engine_apply_delta",
      "engine_set_preview",
      "engine_transport",
      "engine_warm",
      "engine_audition",
      "engine_release",
      "engine_render",
      "engine_peaks",
      "engine_dispose",
    ]) {
      expect(calls).toContain(command);
    }
    expect(events.some((event) => event.kind === "error" && event.code === "no-device")).toBe(true);
  });
});

describe("renderContext", () => {
  const doc = { arrangement: { sections: [{ lengthTicks: 1920 }, { lengthTicks: 1920 }] } };

  it("rejects a range the document cannot contain before calling the host", async () => {
    const render = vi.fn();
    const host = { render } as unknown as EngineHost;
    for (const range of [
      { startTick: 960, endTick: 960 },
      { startTick: 1920, endTick: 960 },
      { startTick: -1, endTick: 960 },
      { startTick: 0, endTick: 3841 },
      { startTick: 0.5, endTick: 960 },
    ]) {
      await expect(renderContext(host, doc, range)).rejects.toThrow(RangeError);
    }
    await expect(renderContext(host, doc, { startTick: 0, endTick: 960 }, [])).rejects.toThrow(
      "the track list is empty",
    );
    expect(render).not.toHaveBeenCalled();
  });

  it("returns the single context.wav the engine produced", async () => {
    const render = vi.fn(async () => ({
      channels: 2 as const,
      sampleRate: 48000 as const,
      format: { container: "wav", bits: 32 } as const,
      frames: 24_000,
      files: [{ name: "song.wav", bytes: new Uint8Array([1]), frames: 24_000 }],
    }));
    const host = { render } as unknown as EngineHost;
    await expect(renderContext(host, doc, { startTick: 0, endTick: 960 })).rejects.toThrow(
      "song.wav",
    );
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

describe("resizeStateBlock", () => {
  it("keeps the transport and playhead across a reload that changes the track count", () => {
    const before = new Uint32Array(stateWordCount(1));
    before[0] = 1; // playing
    before[2] = 480_000; // playhead, low word
    const after = resizeStateBlock(before, 5);
    expect(after.length).toBe(stateWordCount(5));
    const state = decodeStateWords(after);
    expect(state.transport).toBe(decodeStateWords(before).transport);
    expect(state.playhead).toBe(480_000);
    expect(state.tracks).toHaveLength(5);
    expect(state.tracks.every((track) => track.rms === 0)).toBe(true);
    expect(after.buffer).toBeInstanceOf(SharedArrayBuffer);
  });
});
