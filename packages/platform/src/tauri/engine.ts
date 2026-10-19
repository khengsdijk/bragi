/**
 * The desktop `EngineHost` (specs/03-audio-engine.md §3.2).
 *
 * The engine runs natively in the Tauri process: `bragi-engine-native` owns the
 * cpal stream, the mmap PCM cache and a `bragi-engine` instance. This adapter
 * sends commands through `invoke` and polls `engine_state` at 60 Hz.
 *
 * The Rust command surface it expects is registered by `apps/desktop/src-tauri`:
 *
 * | Command | Payload | Returns |
 * |---|---|---|
 * | `engine_init` | `{ bufferFrames }` | `{ playback: boolean }` |
 * | `engine_load_document` | `{ doc }` | `{ planVersion }` |
 * | `engine_apply_delta` | `{ doc, delta }` | `{ planVersion }` |
 * | `engine_transport` | `{ cmd }` | – |
 * | `engine_set_preview` | `{ patch }` | – |
 * | `engine_state` | – | `EngineState` |
 * | `engine_render` | `{ job }` | binary export frame (`decodeExportFrame`) |
 * | `engine_peaks` | `{ asset, level }` | `number[]` |
 * | `engine_dispose` | – | – |
 */
import { decodeExportFrame, jobFormat, pyramidLevel } from "../engine/codec.js";
import type {
  AssetHash,
  AudioFormat,
  EngineDelta,
  EngineEvent,
  EngineHost,
  EngineState,
  PeakLevel,
  PreviewPatch,
  ProjectJson,
  RenderJob,
  RenderResult,
  TileSpec,
  TransportCmd,
  Unsubscribe,
} from "../engine/types.js";

/** An `invoke`-shaped call, so the adapter is testable without Tauri. */
export type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export interface TauriEngineOptions {
  readonly invoke: Invoke;
  /** Playback buffer in frames; 256 by default, 64–2048 (03 §3.2). */
  readonly bufferFrames?: number;
  /** How often to poll `engine_state`; defaults to 60 Hz. */
  readonly pollMs?: number;
  /** Timers, injectable for tests. */
  readonly setInterval?: (callback: () => void, ms: number) => number;
  readonly clearInterval?: (handle: number) => void;
}

/** Creates the desktop host. */
export async function createTauriEngineHost(options: TauriEngineOptions): Promise<EngineHost> {
  const { invoke } = options;
  const pollMs = options.pollMs ?? 1000 / 60;
  const setIntervalFn =
    options.setInterval ??
    ((callback: () => void, ms: number) => setInterval(callback, ms) as unknown as number);
  const clearIntervalFn = options.clearInterval ?? ((handle: number) => clearInterval(handle));

  const initial = (await invoke("engine_init", {
    bufferFrames: options.bufferFrames ?? 256,
  })) as { playback?: boolean } | null;
  const playbackAvailable = initial?.playback !== false;

  const stateListeners = new Set<(state: EngineState) => void>();
  const eventListeners = new Set<(event: EngineEvent) => void>();

  const readState = async (): Promise<void> => {
    const state = (await invoke("engine_state")) as EngineState;
    for (const listener of stateListeners) listener(state);
  };
  const poll = setIntervalFn(() => {
    void readState().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      for (const listener of eventListeners) listener({ kind: "error", code: "state", message });
    });
  }, pollMs);

  const announceDevice = (): void => {
    if (playbackAvailable) return;
    for (const listener of eventListeners) {
      listener({
        kind: "error",
        code: "no-device",
        message: "no audio output device; offline render and meters still work",
      });
    }
  };

  let announced = false;
  return {
    async init() {
      const result = (await invoke("engine_init", {
        bufferFrames: options.bufferFrames ?? 256,
      })) as { playback?: boolean } | null;
      if (result?.playback === false && !announced) {
        announced = true;
        announceDevice();
      }
    },
    async loadDocument(doc: ProjectJson) {
      await invoke("engine_load_document", { doc });
    },
    applyDelta(delta: EngineDelta) {
      void invoke("engine_apply_delta", { delta });
    },
    setPreview(preview: PreviewPatch | null) {
      void invoke("engine_set_preview", { patch: preview });
    },
    transport(cmd: TransportCmd) {
      void invoke("engine_transport", { cmd });
    },
    audition(target) {
      void invoke("engine_transport", { cmd: { kind: "audition", on: target !== null } });
    },
    async render(job: RenderJob): Promise<RenderResult> {
      // The Rust service encodes the files and replies with one binary export
      // frame (a raw IPC response, so it arrives as an ArrayBuffer).
      const reply = await invoke("engine_render", { job });
      return decodeExportFrame(toBytes(reply), jobFormat(job));
    },
    async peaks(asset: AssetHash, level: PeakLevel) {
      // The command returns the whole pyramid; pick the level here.
      const bytes = (await invoke("engine_peaks", { asset, level })) as number[] | Uint8Array;
      return pyramidLevel(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes), level);
    },
    spectrogram(_asset: AssetHash, _tile: TileSpec): Promise<Uint8Array> {
      return Promise.reject(new Error("spectrogram is not in v1 (specs/15-open-questions.md Q26)"));
    },
    onState(cb) {
      stateListeners.add(cb);
      return () => stateListeners.delete(cb);
    },
    onEvent(cb) {
      eventListeners.add(cb);
      return () => eventListeners.delete(cb);
    },
    async dispose() {
      clearIntervalFn(poll);
      stateListeners.clear();
      eventListeners.clear();
      await invoke("engine_dispose");
    },
  };
}

/** Re-exported for the app's convenience. */
export type { AudioFormat, Unsubscribe };

/** Normalises what `invoke` hands back for a raw IPC response. */
function toBytes(reply: unknown): Uint8Array {
  if (reply instanceof Uint8Array) return reply;
  if (reply instanceof ArrayBuffer) return new Uint8Array(reply);
  if (Array.isArray(reply)) return Uint8Array.from(reply as number[]);
  throw new Error("engine_render returned an unexpected reply");
}
