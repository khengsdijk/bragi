import type { EngineHost, EngineState, TransportCmd } from "@bragi/platform";
import { describe, expect, it, vi } from "vitest";

import { encodeWav16, renderStem } from "../api/demo-audio.js";
import { SAMPLE_RATE, SHORT_DEMO } from "../api/demo-song.js";
import { createEngineController, ENGINE_SAMPLE_RATE } from "../state/engine-controller.js";
import { trackToggleBatch } from "../state/ops.js";
import { loadDemo } from "./fixtures.js";

function fakeHost() {
  const commands: TransportCmd[] = [];
  const listeners = new Set<(state: EngineState) => void>();
  const host = {
    init: vi.fn(async () => {}),
    loadDocument: vi.fn(async () => {}),
    applyDelta: vi.fn(),
    setPreview: vi.fn(),
    transport: vi.fn((cmd: TransportCmd) => {
      commands.push(cmd);
    }),
    audition: vi.fn(),
    render: vi.fn(),
    peaks: vi.fn(),
    spectrogram: vi.fn(),
    onState: vi.fn((cb: (state: EngineState) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }),
    onEvent: vi.fn(() => () => {}),
    dispose: vi.fn(async () => {}),
  } satisfies EngineHost;
  const emit = (state: Partial<EngineState>): void => {
    for (const listener of listeners) {
      listener({
        transport: "stopped",
        playhead: 0,
        auditioning: false,
        planVersion: 1,
        underruns: 0,
        tracks: [],
        master: { peak: 0, rms: 0 },
        ...state,
      });
    }
  };
  return { host, commands, emit };
}

describe("engine controller (transport bar wiring)", () => {
  it("is unavailable without an engine factory", async () => {
    const { store } = await loadDemo();
    const controller = createEngineController({
      document: () => store.store.getState().doc,
      durationSec: () => 32,
    });
    expect(controller.store.getState().status).toBe("unavailable");
    expect(await controller.ensure()).toBe(false);
  });

  it("creates the engine on first play, loads the document and sends play", async () => {
    const { store } = await loadDemo();
    const { host, commands } = fakeHost();
    const createEngine = vi.fn(async () => host);
    const controller = createEngineController({
      createEngine,
      document: () => store.store.getState().doc,
      durationSec: () => 32,
    });
    expect(createEngine).not.toHaveBeenCalled();
    await controller.play();
    expect(createEngine).toHaveBeenCalledTimes(1);
    expect(host.init).toHaveBeenCalledWith({ sampleRate: 48000 });
    expect(host.loadDocument).toHaveBeenCalledWith(store.store.getState().doc);
    expect(commands).toEqual([{ kind: "play" }]);
    // A second play reuses the engine.
    await controller.play();
    expect(createEngine).toHaveBeenCalledTimes(1);
  });

  it("primes the audio context synchronously before creating the engine", async () => {
    const { store } = await loadDemo();
    const { host } = fakeHost();
    const order: string[] = [];
    const primeEngine = vi.fn(() => order.push("prime"));
    const createEngine = vi.fn(async () => {
      order.push("create");
      return host;
    });
    const controller = createEngineController({
      createEngine,
      primeEngine,
      document: () => store.store.getState().doc,
      durationSec: () => 32,
    });

    // The call itself, not just its settled promise, must run inside the click.
    const playing = controller.play();
    expect(primeEngine).toHaveBeenCalledTimes(1);
    await playing;
    expect(order).toEqual(["prime", "create"]);

    // A second Play (a suspended context after a tab switch) resumes it again.
    await controller.play();
    expect(primeEngine).toHaveBeenCalledTimes(2);
  });

  it("plays as soon as a slow first load finishes instead of dropping Play", async () => {
    const { store } = await loadDemo();
    const { host, commands } = fakeHost();
    const pending: (() => void)[] = [];
    host.loadDocument.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          pending.push(resolve);
        }),
    );
    const controller = createEngineController({
      createEngine: async () => host,
      document: () => store.store.getState().doc,
      durationSec: () => 32,
    });

    const playing = controller.play();
    await vi.waitFor(() => expect(host.loadDocument).toHaveBeenCalledTimes(1));
    // Still decoding/loading: Play is remembered, not sent or dropped.
    expect(commands).toEqual([]);
    pending.shift()?.();
    await playing;
    expect(commands).toEqual([{ kind: "play" }]);
  });

  it("ends on the newest document when a commit lands during a full reload", async () => {
    const { store } = await loadDemo();
    const { host } = fakeHost();
    const controller = createEngineController({
      createEngine: async () => host,
      document: () => store.store.getState().doc,
      durationSec: () => 32,
    });
    await controller.play();
    const releases: (() => void)[] = [];
    host.loadDocument.mockImplementation(
      () => new Promise<void>((resolve) => releases.push(resolve)),
    );
    host.loadDocument.mockClear();
    host.applyDelta.mockClear();

    const doc = store.store.getState().doc;
    if (doc === null) throw new Error("no document");
    // A structural commit (an analysis stage adding tracks) starts a reload…
    const structural = { batch: null, delta: { requiresFullResync: true }, revision: 2 };
    controller.commit(structural, doc);
    expect(host.loadDocument).toHaveBeenCalledTimes(1);
    // …and a solo lands while it runs.
    const solo = trackToggleBatch(doc, "trk_bass", "solo", true);
    if (solo === null) throw new Error("no batch");
    const outcome = store.apply(solo);
    if (!outcome.ok) throw new Error("solo rejected");
    controller.commit(outcome.commit, outcome.doc);
    // Applied as a delta it would be overwritten by the older load; it waits for the next load.
    expect(host.applyDelta).toHaveBeenCalledTimes(1);

    releases.shift()?.();
    await vi.waitFor(() => expect(host.loadDocument).toHaveBeenCalledTimes(2));
    expect(host.loadDocument).toHaveBeenLastCalledWith(outcome.doc);
    releases.shift()?.();
    await vi.waitFor(() => expect(releases).toHaveLength(0));
    expect(host.loadDocument).toHaveBeenCalledTimes(2);
  });

  it("follows the engine state: playhead seconds, playing flag and per-track meters", async () => {
    const { store } = await loadDemo();
    const { host, emit } = fakeHost();
    const controller = createEngineController({
      createEngine: async () => host,
      document: () => store.store.getState().doc,
      durationSec: () => 32,
    });
    await controller.ensure();
    emit({
      transport: "playing",
      playhead: 3 * ENGINE_SAMPLE_RATE,
      tracks: [
        { peak: 0.5, rms: 0.25 },
        { peak: 0.1, rms: 0.05 },
        { peak: 0, rms: 0 },
        { peak: 0, rms: 0 },
      ],
    });
    const state = controller.store.getState();
    expect(state.playing).toBe(true);
    expect(state.positionSec).toBe(3);
    expect(state.meters).toMatchObject({ trk_drums: 0.25, trk_bass: 0.05 });
    emit({ transport: "paused", playhead: 3 * ENGINE_SAMPLE_RATE });
    expect(controller.store.getState().playing).toBe(false);
  });

  it("seeks in samples, clamps to the song, and remembers a seek made before the engine exists", async () => {
    const { store } = await loadDemo();
    const { host, commands } = fakeHost();
    const controller = createEngineController({
      createEngine: async () => host,
      document: () => store.store.getState().doc,
      durationSec: () => 32,
    });
    controller.seek(5);
    expect(controller.store.getState().positionSec).toBe(5);
    await controller.ensure();
    expect(commands).toContainEqual({ kind: "seek", sample: 5 * ENGINE_SAMPLE_RATE });
    controller.seek(999);
    expect(commands.at(-1)).toEqual({ kind: "seek", sample: 32 * ENGINE_SAMPLE_RATE });
    controller.seek(-4);
    expect(commands.at(-1)).toEqual({ kind: "seek", sample: 0 });
  });

  it("loops the whole song and back to start stops", async () => {
    const { store } = await loadDemo();
    const { host, commands } = fakeHost();
    const controller = createEngineController({
      createEngine: async () => host,
      document: () => store.store.getState().doc,
      durationSec: () => 32,
    });
    await controller.ensure();
    controller.setLoop(true);
    expect(commands.at(-1)).toEqual({ kind: "loop", start: 0, end: 32 * ENGINE_SAMPLE_RATE });
    controller.setLoop(false);
    expect(commands.at(-1)).toEqual({ kind: "loop", start: 0, end: null });
    controller.toStart();
    expect(commands.at(-1)).toEqual({ kind: "stop" });
    expect(controller.store.getState().positionSec).toBe(0);
  });

  it("loops one part while the transport button still means the whole song", async () => {
    const { store } = await loadDemo();
    const { host, commands } = fakeHost();
    const controller = createEngineController({
      createEngine: async () => host,
      document: () => store.store.getState().doc,
      durationSec: () => 32,
    });
    // A part loop chosen before audio starts is remembered and applied on start.
    controller.setLoopRange({ startSec: 4, endSec: 12 });
    expect(controller.store.getState()).toMatchObject({
      loop: true,
      loopRange: { startSec: 4, endSec: 12 },
    });
    await controller.ensure();
    expect(commands).toContainEqual({
      kind: "loop",
      start: 4 * ENGINE_SAMPLE_RATE,
      end: 12 * ENGINE_SAMPLE_RATE,
    });

    // The loop button is still the whole-song loop and clears the range.
    controller.setLoop(true);
    expect(controller.store.getState()).toMatchObject({ loop: true, loopRange: null });
    expect(commands.at(-1)).toEqual({
      kind: "loop",
      start: 0,
      end: 32 * ENGINE_SAMPLE_RATE,
    });

    // Ranges are clamped to the song.
    controller.setLoopRange({ startSec: -3, endSec: 99 });
    expect(controller.store.getState().loopRange).toEqual({ startSec: 0, endSec: 32 });
    expect(commands.at(-1)).toEqual({
      kind: "loop",
      start: 0,
      end: 32 * ENGINE_SAMPLE_RATE,
    });

    controller.setLoopRange(null);
    expect(controller.store.getState()).toMatchObject({ loop: false, loopRange: null });
    expect(commands.at(-1)).toEqual({ kind: "loop", start: 0, end: null });
  });

  it("forwards a Song Store commit to the engine as a delta (mute/solo from the ribbons)", async () => {
    const { store } = await loadDemo();
    const { host } = fakeHost();
    const controller = createEngineController({
      createEngine: async () => host,
      document: () => store.store.getState().doc,
      durationSec: () => 32,
    });
    await controller.ensure();
    const doc = store.store.getState().doc;
    if (!doc) throw new Error("no document");
    const batch = trackToggleBatch(doc, "trk_drums", "solo", true);
    if (!batch) throw new Error("no batch");
    const outcome = store.apply(batch);
    if (!outcome.ok) throw new Error("rejected");
    controller.commit(outcome.commit, outcome.doc);
    expect(host.applyDelta).toHaveBeenCalledTimes(1);
    const delta = host.applyDelta.mock.calls[0]?.[0] as {
      tracksUpdated: { id: string; solo: boolean }[];
    };
    expect(delta.tracksUpdated).toEqual([expect.objectContaining({ id: "trk_drums", solo: true })]);
    // A mix-only change needs no full reload.
    expect(host.loadDocument).toHaveBeenCalledTimes(1);
  });

  it("reports an engine that fails to start instead of throwing at the user", async () => {
    const { store } = await loadDemo();
    const controller = createEngineController({
      createEngine: async () => {
        throw new Error("no audio device");
      },
      document: () => store.store.getState().doc,
      durationSec: () => 32,
    });
    await controller.play();
    expect(controller.store.getState().status).toBe("error");
    expect(controller.store.getState().error).toBe("no audio device");
  });
});

describe("generated demo audio", () => {
  it("is deterministic, mono 48 kHz 16-bit WAV, exactly as long as the song", () => {
    const first = encodeWav16(renderStem(SHORT_DEMO, "drums"));
    const second = encodeWav16(renderStem(SHORT_DEMO, "drums"));
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
    const view = new DataView(first.buffer);
    expect(String.fromCharCode(...first.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...first.subarray(8, 12))).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(SAMPLE_RATE);
    expect(view.getUint16(34, true)).toBe(16);
    // 16 bars at 120 BPM = 32 s.
    expect(view.getUint32(40, true) / 2).toBe(32 * SAMPLE_RATE);
  });

  it("is silent where an instrument does not play and loud where it does", () => {
    const drums = renderStem(SHORT_DEMO, "drums");
    const peak = (from: number, to: number): number => {
      let max = 0;
      for (let i = from * SAMPLE_RATE; i < to * SAMPLE_RATE; i += 1) {
        max = Math.max(max, Math.abs(drums[i] ?? 0));
      }
      return max;
    };
    expect(peak(0, 4)).toBe(0); // the intro has no drums
    expect(peak(4, 12)).toBeGreaterThan(0.3);
  });
});
