/**
 * The `EngineHost` interface and its value types
 * (specs/03-audio-engine.md §3.3, §5.3, §5.4, §9).
 *
 * Both adapters (`./web/engine.ts`, `./tauri/engine.ts`) implement this, so
 * `packages/app` never knows which host it is talking to. The document and delta
 * types are structured JSON: they come from `bragi-model` and are not re-typed
 * here, so this package keeps no dependency on the schema package.
 */

/** A song document as JSON (`bragi-model::generated::Project`). */
export type ProjectJson = Readonly<Record<string, unknown>>;

/** A change set as JSON (`bragi_model::EngineDelta`). */
export type EngineDelta = Readonly<Record<string, unknown>>;

/** A commit identifier: `cmt_` + 26 base32 characters (02 §2.1). */
export type CommitId = string;

/** An asset identifier: `sha256:` + 64 lowercase hex characters (02 §2.1). */
export type AssetHash = `sha256:${string}`;

/** The transport states of 03 §5.1. */
export type TransportStateName = "stopped" | "playing" | "paused" | "looping" | "scrubbing";

/** Waveform pyramid bin sizes (03 §10). */
export type PeakLevel = 256 | 1024 | 4096 | 16384;

/** What a spectrogram tile request asks for (03 §10); v1 may reject these. */
export interface TileSpec {
  readonly bins: number;
  readonly hop: number;
  readonly frames: number;
}

/** One meter value. */
export interface MeterValue {
  /** Peak absolute amplitude. */
  readonly peak: number;
  /** RMS amplitude. */
  readonly rms: number;
}

/** The engine state the UI reads at 60 Hz (03 §3.1/§3.3). */
export interface EngineState {
  readonly transport: TransportStateName;
  /** Playhead in output samples at 48 kHz. */
  readonly playhead: number;
  /** Whether the audition overlay is active (03 §5.4). */
  readonly auditioning: boolean;
  readonly planVersion: number;
  readonly underruns: number;
  /** Per-track meters, in document order. */
  readonly tracks: readonly MeterValue[];
  readonly master: MeterValue;
}

/** A transient drag state (03 §5.3). */
export type PreviewPatch =
  | { readonly kind: "moveSection"; readonly sectionId: string; readonly toIndex: number }
  | { readonly kind: "clipOffset"; readonly clipId: string; readonly deltaTicks: number }
  | { readonly kind: "trackGain"; readonly trackId: string; readonly db: number }
  | { readonly kind: "trackPan"; readonly trackId: string; readonly pan: number }
  | { readonly kind: "trackMute"; readonly trackId: string; readonly mute: boolean }
  | {
      readonly kind: "fxParam";
      readonly fxId: string;
      readonly param: string;
      readonly value: number;
    }
  | {
      readonly kind: "macro";
      readonly trackId: string;
      readonly macroId: string;
      readonly value: number;
    };

/** A transport command (03 §5.1). */
export type TransportCmd =
  | { readonly kind: "play" }
  | { readonly kind: "pause" }
  | { readonly kind: "stop" }
  | { readonly kind: "seek"; readonly sample: number }
  | { readonly kind: "loop"; readonly start: number; readonly end: number | null }
  | { readonly kind: "scrubBegin" }
  | { readonly kind: "scrubTo"; readonly sample: number }
  | { readonly kind: "scrubEnd" }
  | { readonly kind: "audition"; readonly on: boolean };

/** An export format (03 §9). */
export type AudioFormat =
  | { readonly container: "wav"; readonly bits: 16 | 24 | 32 }
  | { readonly container: "flac"; readonly bits: 16 | 24 }
  | { readonly container: "mp3"; readonly kbps: 128 | 192 | 320 };

/** An offline render request (03 §9). */
export type RenderJob =
  | {
      readonly kind: "mixdown";
      readonly range?: { readonly startTick: number; readonly endTick: number };
      /**
       * The range already converted to output samples. The UI owns the tempo map
       * (through `bragi-model`), so it can convert; hosts use this when the
       * caller did.
       */
      readonly startSample?: number;
      readonly frames?: number;
      readonly format: AudioFormat;
      readonly normalize?: { readonly lufs: number; readonly truePeakDb: number };
    }
  | {
      readonly kind: "stems";
      readonly tracks: readonly string[] | "all";
      readonly format: AudioFormat;
    }
  | {
      readonly kind: "context";
      readonly range: { readonly startTick: number; readonly endTick: number };
      readonly tracks: readonly string[] | "all";
    }
  | { readonly kind: "cache"; readonly sectionId: string };

/** An offline render result. */
export interface RenderResult {
  /** Always stereo at 48 kHz (`specs/02-song-model.md` §2.2). */
  readonly channels: 2;
  readonly sampleRate: 48000;
  readonly format: AudioFormat;
  /** Encoded bytes in the requested format. */
  readonly bytes: Uint8Array;
  /** Frames rendered. */
  readonly frames: number;
}

/** An engine event (03 §3.3): underruns, device changes, errors. */
export type EngineEvent =
  | { readonly kind: "underrun"; readonly sample: number; readonly count: number }
  | { readonly kind: "planCompiled"; readonly version: number }
  | { readonly kind: "previewChanged"; readonly active: boolean }
  | { readonly kind: "deviceChanged"; readonly deviceId: string }
  | { readonly kind: "error"; readonly code: string; readonly message: string };

/** A state subscription's cancel handle. */
export type Unsubscribe = () => void;

/**
 * The audio engine, as the app sees it (03 §3.3).
 *
 * `render`, `peaks` and `spectrogram` are asynchronous wherever they run;
 * `transport`, `setPreview` and `applyDelta` are synchronous command pushes.
 */
export interface EngineHost {
  /** Starts the audio graph and loads nothing. */
  init(opts: { readonly sampleRate: 48000; readonly outputDeviceId?: string }): Promise<void>;
  /** Full load (project open). */
  loadDocument(doc: ProjectJson): Promise<void>;
  /** Applies a committed change (`bragi-model`'s `diff`). */
  applyDelta(delta: EngineDelta): void;
  /** Transient drag state, or `null` to fall back to the committed plan. */
  setPreview(preview: PreviewPatch | null): void;
  /** Play, pause, stop, seek, loop, scrub, audition. */
  transport(cmd: TransportCmd): void;
  /** A/B audition of a candidate commit (03 §5.4). */
  audition(target: { readonly commitId: CommitId; readonly doc: ProjectJson } | null): void;
  /** Offline render (03 §9). */
  render(job: RenderJob): Promise<RenderResult>;
  /** Waveform peaks at one pyramid level (03 §10). */
  peaks(asset: AssetHash, level: PeakLevel): Promise<Float32Array>;
  /** Spectrogram tiles (03 §10). Not in v1 for every host. */
  spectrogram(asset: AssetHash, tile: TileSpec): Promise<Uint8Array>;
  /** Subscribes to the 60 Hz state stream. */
  onState(cb: (state: EngineState) => void): Unsubscribe;
  /** Subscribes to engine events. */
  onEvent(cb: (event: EngineEvent) => void): Unsubscribe;
  /** Stops audio and releases the host. */
  dispose(): Promise<void>;
}
