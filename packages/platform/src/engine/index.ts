/**
 * The engine seam (specs/03-audio-engine.md §3.3): the `EngineHost` interface,
 * its value types and the wire encodings the web host shares with the
 * AudioWorklet. Implementations live in `../web/engine.js` and
 * `../tauri/engine.js`.
 */
export * from "./codec.js";
export type {
  AssetHash,
  AudioFormat,
  CommitId,
  EngineDelta,
  EngineEvent,
  EngineHost,
  EngineState,
  MeterValue,
  PeakLevel,
  PreviewPatch,
  ProjectJson,
  RenderJob,
  RenderResult,
  TileSpec,
  TransportCmd,
  TransportStateName,
  Unsubscribe,
} from "./types.js";
