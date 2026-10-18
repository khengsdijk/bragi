/**
 * `@bragi/platform`: the interfaces the app is written against, plus the
 * platform-neutral pieces (migration runner, blob hashing, in-memory
 * adapters). Host-specific adapters live behind the `./web`, `./tauri` and
 * `./auto` entry points so that importing this module never pulls them in.
 */
export const PACKAGE_NAME = "@bragi/platform";

export { assertBlobHash, blobHashOf, isBlobHash } from "./blob-hash.js";
export {
  bytesToFloat32,
  decodeStateWords,
  encodeTransport,
  float32ToBytes,
  packCommand,
  pyramidLevel,
  STATE_HEADER_WORDS,
  unpackCommand,
} from "./engine/codec.js";
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
} from "./engine/types.js";
export { createMemoryBlobCache, createScriptedFileAccess } from "./memory.js";
export { parseMigrations, runMigrations } from "./migrations.js";
export type {
  BlobCache,
  BlobHash,
  FileAccess,
  LocalDB,
  Migration,
  PickedFile,
  PickFilesOptions,
  Platform,
  PlatformKind,
  Row,
  RunResult,
  SqlValue,
  Statement,
} from "./types.js";
