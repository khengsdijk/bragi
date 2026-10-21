/**
 * The transport bar's brain: it owns the `EngineHost` for one open song and a small Zustand store
 * of what the bar shows (07 §1 "Transport + tools").
 *
 * The host is created lazily, from a user gesture (a browser only starts an audio context then),
 * and loaded with the current document. Song Store commits reach it through
 * {@link EngineController.commit}: mix-only changes go through `applyDelta`, structural ones
 * through a full `loadDocument` (03 §3.3).
 */
import type {
  AuditionSlot,
  CandidateSlot,
  ContextRange,
  EngineDelta,
  EngineHost,
  EngineState,
  ProjectJson,
} from "@bragi/platform";
import { renderContext as renderContextAudio } from "@bragi/platform";
import type { Project } from "@bragi/schemas";
import { createStore, type StoreApi } from "zustand/vanilla";

import type { Commit } from "./song-store.js";

/** The output sample rate of the engine (02 §2.2). */
export const ENGINE_SAMPLE_RATE = 48000;

export type EngineStatus = "idle" | "starting" | "ready" | "unavailable" | "error";

export interface TransportViewState {
  readonly status: EngineStatus;
  readonly playing: boolean;
  /** The playhead, in seconds. */
  readonly positionSec: number;
  readonly durationSec: number;
  readonly loop: boolean;
  /** The part loop when one is active, or `null` for the whole song (07 §4.1). */
  readonly loopRange: { readonly startSec: number; readonly endSec: number } | null;
  readonly underruns: number;
  /** Per-track meter level (RMS, 0..1) by track id, for the ribbon glow. */
  readonly meters: Readonly<Record<string, number>>;
  readonly error: string | null;
  /** The warm plan that is audible: 0 is HEAD, 1–3 are audition candidates (03 §5.4). */
  readonly auditionSlot: AuditionSlot;
}

export interface EngineControllerOptions {
  /** Absent when the host cannot play audio. */
  readonly createEngine?: (() => Promise<EngineHost>) | undefined;
  /**
   * Synchronously creates or resumes the audio context. {@link EngineController.play} calls it
   * before its first `await`, because browsers only start audio inside the click's activation.
   */
  readonly primeEngine?: (() => void) | undefined;
  readonly document: () => Project | null;
  readonly durationSec: () => number;
}

export interface EngineController {
  readonly store: StoreApi<TransportViewState>;
  /** Creates and loads the engine if it is not running yet. Call from a user gesture. */
  ensure(): Promise<boolean>;
  play(): Promise<void>;
  pause(): void;
  toggle(): Promise<void>;
  /** Back to the start (and stop). */
  toStart(): void;
  seek(sec: number): void;
  setLoop(loop: boolean): void;
  /** Loops one range (a part), or `null` to stop looping. The loop button still means the song. */
  setLoopRange(range: { readonly startSec: number; readonly endSec: number } | null): void;
  /** Tells the engine about a Song Store commit. */
  commit(commit: Commit, doc: Project): void;
  /** A new document replaced the old one (project open). */
  documentReplaced(): void;
  /**
   * Prepares `doc` in a warm candidate slot (03 §5.4). Starts the engine if needed, so call it
   * from a user gesture the first time. Resolves `false` when there is no engine.
   */
  warm(slot: CandidateSlot, doc: Project): Promise<boolean>;
  /** Drops a warm candidate. */
  release(slot: CandidateSlot): void;
  /** Crossfades to a warm slot at the same playhead; 0 returns to HEAD. */
  audition(slot: AuditionSlot): void;
  /**
   * Renders a tick range of the song as the 48 kHz context WAV generation conditions on
   * (03 §9). Starts the engine if it is not running yet, so call it from a user gesture.
   */
  renderContext(range: ContextRange, tracks?: readonly string[] | "all"): Promise<Uint8Array>;
  dispose(): Promise<void>;
}

export function createEngineController(options: EngineControllerOptions): EngineController {
  const store = createStore<TransportViewState>(() => ({
    status: options.createEngine ? "idle" : "unavailable",
    playing: false,
    positionSec: 0,
    durationSec: options.durationSec(),
    loop: false,
    loopRange: null,
    underruns: 0,
    meters: {},
    error: null,
    auditionSlot: 0,
  }));

  let engine: EngineHost | null = null;
  let starting: Promise<boolean> | null = null;
  let unsubscribe: (() => void) | null = null;
  let pendingSeekSec = 0;
  /** The full reload in flight, if any, and the newest document it must end on. */
  let reloading: Promise<void> | null = null;
  let latestDoc: Project | null = null;

  /**
   * Loads `latestDoc` into the engine, again and again until no newer document arrived while a
   * load ran. A load is async, so a delta committed during one (a solo while an analysis stage
   * resyncs) would otherwise be overwritten when the older document finishes loading.
   */
  const reload = (): void => {
    if (reloading) return;
    reloading = (async () => {
      let loaded: Project | null = null;
      while (engine && latestDoc !== null && latestDoc !== loaded) {
        loaded = latestDoc;
        await engine.loadDocument(loaded as unknown as ProjectJson);
      }
    })().finally(() => {
      reloading = null;
    });
  };

  const onState = (state: EngineState): void => {
    const doc = options.document();
    const meters: Record<string, number> = {};
    if (doc) {
      doc.tracks.forEach((track, index) => {
        meters[track.id] = state.tracks[index]?.rms ?? 0;
      });
    }
    const previous = store.getState();
    const positionSec = state.playhead / ENGINE_SAMPLE_RATE;
    const playing = state.transport === "playing" || state.transport === "looping";
    // Re-rendering the transport bar 60 times a second only matters while something moves.
    if (
      !playing &&
      !previous.playing &&
      Math.abs(positionSec - previous.positionSec) < 1e-6 &&
      state.underruns === previous.underruns
    ) {
      return;
    }
    store.setState({ positionSec, playing, meters, underruns: state.underruns });
  };

  const start = async (): Promise<boolean> => {
    if (!options.createEngine) return false;
    store.setState({ status: "starting", error: null });
    try {
      const host = await options.createEngine();
      await host.init({ sampleRate: 48000 });
      const doc = options.document();
      if (doc) await host.loadDocument(doc as unknown as ProjectJson);
      unsubscribe = host.onState(onState);
      engine = host;
      store.setState({ status: "ready", durationSec: options.durationSec() });
      // A loop chosen before audio started (a part loop from the menu) is applied now.
      const loop = store.getState();
      if (loop.loop) {
        const start = loop.loopRange?.startSec ?? 0;
        const end = loop.loopRange?.endSec ?? options.durationSec();
        host.transport({
          kind: "loop",
          start: Math.round(start * ENGINE_SAMPLE_RATE),
          end: Math.round(end * ENGINE_SAMPLE_RATE),
        });
      }
      if (pendingSeekSec > 0) {
        host.transport({ kind: "seek", sample: Math.round(pendingSeekSec * ENGINE_SAMPLE_RATE) });
      }
      return true;
    } catch (error) {
      store.setState({
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  };

  const ensure = (): Promise<boolean> => {
    if (engine) return Promise.resolve(true);
    starting ??= start().finally(() => {
      starting = null;
    });
    return starting;
  };

  const controller: EngineController = {
    store,
    ensure,
    async play() {
      // Must stay before the first `await`: Chromium and Firefox only start/resume an
      // AudioContext while the click's user activation is on the stack.
      options.primeEngine?.();
      if (!(await ensure()) || !engine) return;
      engine.transport({ kind: "play" });
    },
    pause() {
      engine?.transport({ kind: "pause" });
    },
    async toggle() {
      if (store.getState().playing) controller.pause();
      else await controller.play();
    },
    toStart() {
      pendingSeekSec = 0;
      engine?.transport({ kind: "stop" });
      store.setState({ positionSec: 0, playing: false });
    },
    seek(sec) {
      const clamped = Math.max(0, Math.min(sec, options.durationSec()));
      pendingSeekSec = clamped;
      store.setState({ positionSec: clamped });
      engine?.transport({ kind: "seek", sample: Math.round(clamped * ENGINE_SAMPLE_RATE) });
    },
    setLoop(loop) {
      store.setState({ loop, loopRange: null });
      if (!engine) return;
      const lengthSamples = Math.round(options.durationSec() * ENGINE_SAMPLE_RATE);
      engine.transport({ kind: "loop", start: 0, end: loop ? lengthSamples : null });
    },
    setLoopRange(range) {
      if (range === null) {
        controller.setLoop(false);
        return;
      }
      const duration = options.durationSec();
      const startSec = Math.max(0, Math.min(range.startSec, duration));
      const endSec = Math.max(startSec, Math.min(range.endSec, duration));
      store.setState({ loop: true, loopRange: { startSec, endSec } });
      engine?.transport({
        kind: "loop",
        start: Math.round(startSec * ENGINE_SAMPLE_RATE),
        end: Math.round(endSec * ENGINE_SAMPLE_RATE),
      });
    },
    commit(commit, doc) {
      if (!engine) return;
      const delta = commit.delta as EngineDelta;
      latestDoc = doc;
      // During a reload the delta would land on the plan the reload replaces; the reload loop
      // picks up `doc` instead.
      if (reloading === null) engine.applyDelta(delta);
      if (delta.requiresFullResync === true || reloading !== null) reload();
      store.setState({ durationSec: options.durationSec() });
    },
    documentReplaced() {
      store.setState({ durationSec: options.durationSec(), positionSec: 0 });
      latestDoc = options.document();
      reload();
    },
    async warm(slot, doc) {
      if (!(await ensure()) || !engine) return false;
      await engine.warm(slot, doc as unknown as ProjectJson);
      return true;
    },
    release(slot) {
      engine?.release(slot);
    },
    audition(slot) {
      store.setState({ auditionSlot: slot });
      engine?.audition(slot);
    },
    async renderContext(range, tracks = "all") {
      options.primeEngine?.();
      if (!(await ensure()) || engine === null) {
        throw new Error("the audio engine is not available");
      }
      const doc = options.document();
      if (doc === null) throw new Error("no song is open");
      return renderContextAudio(engine, doc as unknown as ProjectJson, range, tracks);
    },
    async dispose() {
      unsubscribe?.();
      unsubscribe = null;
      const host = engine;
      engine = null;
      if (host) await host.dispose();
    },
  };
  return controller;
}
