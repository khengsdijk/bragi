/**
 * Wire encodings shared by the engine adapters
 * (specs/03-audio-engine.md §3.1).
 *
 * The AudioWorklet and the decoder worker talk over fixed layouts:
 *
 * - **Commands** are packed into `u64` words for the lock-free SPSC ring
 *   (`bragi_engine::rt::SpscU64`): the high byte is the opcode, the low 56 bits
 *   are the payload.
 * - **State** is the engine's word block (`bragi_engine::rt::StateBlock`): eight
 *   header words, then `[peak, rms]` per track, then the master pair. All values
 *   are `f32` bit patterns stored in `u32` words.
 *
 * Every function here is pure and synchronous so the layout can be unit-tested
 * without a browser.
 */
import type {
  AudioFormat,
  EngineState,
  ExportedFile,
  MeterValue,
  RenderResult,
  TransportStateName,
} from "./types.js";

/** Opcodes, mirroring `bragi-engine-wasm`'s `TRANSPORT_*` constants. */
export const OP_PLAY = 0;
export const OP_PAUSE = 1;
export const OP_STOP = 2;
export const OP_SEEK = 3;
export const OP_LOOP = 4;
export const OP_LOOP_CLEAR = 5;
export const OP_AUDITION = 6;
/** Second word of a loop command: the region end. */
export const OP_LOOP_END = 7;

/** The number of header words in the engine state block. */
export const STATE_HEADER_WORDS = 8;

const PAYLOAD_MASK = 0x00ff_ffff_ffff_ffffn;

/** Packs `(opcode, payload)` into one ring word. */
export function packCommand(opcode: number, payload: number | bigint = 0): bigint {
  const value = BigInt(payload) & PAYLOAD_MASK;
  return (BigInt(opcode & 0xff) << 56n) | value;
}

/** Splits a ring word back into `(opcode, payload)`. */
export function unpackCommand(word: bigint): { opcode: number; payload: bigint } {
  return { opcode: Number(word >> 56n), payload: word & PAYLOAD_MASK };
}

/**
 * The transport commands for a transport op, as ring words.
 *
 * `loop` with `end === null` clears the region, matching 03 §5.1.
 */
export function encodeTransport(cmd: import("./types.js").TransportCmd): bigint[] {
  switch (cmd.kind) {
    case "play":
      return [packCommand(OP_PLAY)];
    case "pause":
      return [packCommand(OP_PAUSE)];
    case "stop":
      return [packCommand(OP_STOP)];
    case "seek":
      return [packCommand(OP_SEEK, cmd.sample)];
    case "loop":
      return cmd.end === null
        ? [packCommand(OP_LOOP_CLEAR)]
        : [packCommand(OP_LOOP, cmd.start), packCommand(OP_LOOP_END, cmd.end)];
    case "scrubBegin":
    case "scrubTo":
      return cmd.kind === "scrubTo" ? [packCommand(OP_SEEK, cmd.sample)] : [];
    case "scrubEnd":
      return [];
    case "audition":
      return [packCommand(OP_AUDITION, cmd.on ? 1 : 0)];
    default:
      return [];
  }
}

/** Reads an `f32` from a state word. */
export function wordToFloat(word: number): number {
  const buffer = new DataView(new ArrayBuffer(4));
  buffer.setUint32(0, word, true);
  return buffer.getFloat32(0, true);
}

/** Writes an `f32` to a state word (tests and the worker use this). */
export function floatToWord(value: number): number {
  const buffer = new DataView(new ArrayBuffer(4));
  buffer.setFloat32(0, value, true);
  return buffer.getUint32(0, true);
}

const TRANSPORT_NAMES: readonly TransportStateName[] = [
  "stopped",
  "playing",
  "paused",
  "looping",
  "scrubbing",
];

/**
 * Decodes the engine's state words into an {@link EngineState}.
 *
 * `words` is a `Uint32Array` view of the shared state block. The meter count is
 * `(words.length - STATE_HEADER_WORDS - 2) / 2`; a short block decodes with no
 * meters rather than throwing, because it is a live view that can be read at any
 * moment.
 */
export function decodeStateWords(words: Uint32Array): EngineState {
  if (words.length < STATE_HEADER_WORDS) {
    return {
      transport: "stopped",
      playhead: 0,
      auditioning: false,
      planVersion: 0,
      underruns: 0,
      tracks: [],
      master: { peak: 0, rms: 0 },
    };
  }
  const transport = TRANSPORT_NAMES[words[0] ?? 0] ?? "stopped";
  const auditioning = (words[1] ?? 0) !== 0;
  const playhead = (words[2] ?? 0) + 2 ** 32 * (words[3] ?? 0);
  const underruns = (words[4] ?? 0) + 2 ** 32 * (words[5] ?? 0);
  const planVersion = (words[6] ?? 0) + 2 ** 32 * (words[7] ?? 0);
  const meterWords = words.length - STATE_HEADER_WORDS;
  const trackCount = Math.max(0, Math.floor((meterWords - 2) / 2));
  const tracks: MeterValue[] = [];
  for (let index = 0; index < trackCount; index += 1) {
    tracks.push({
      peak: wordToFloat(words[STATE_HEADER_WORDS + index * 2] ?? 0),
      rms: wordToFloat(words[STATE_HEADER_WORDS + index * 2 + 1] ?? 0),
    });
  }
  const masterIndex = STATE_HEADER_WORDS + trackCount * 2;
  return {
    transport,
    playhead,
    auditioning,
    planVersion,
    underruns,
    tracks,
    master: {
      peak: wordToFloat(words[masterIndex] ?? 0),
      rms: wordToFloat(words[masterIndex + 1] ?? 0),
    },
  };
}

/** Copies a `Float32Array` into raw little-endian bytes. */
export function float32ToBytes(samples: Float32Array): Uint8Array {
  return new Uint8Array(
    samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength),
  );
}

/** Views bytes as `f32` samples. Throws when the length is not a multiple of 4. */
export function bytesToFloat32(bytes: Uint8Array): Float32Array {
  if (bytes.byteLength % 4 !== 0) {
    throw new Error(`byte length ${bytes.byteLength} is not a multiple of 4`);
  }
  if (bytes.byteOffset % 4 === 0) {
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  }
  const copy = new Uint8Array(bytes);
  return new Float32Array(copy.buffer, 0, copy.byteLength / 4);
}

/**
 * Takes one pyramid level out of the serialised format
 * (`bragi_engine::peaks::PeakPyramid::to_bytes`).
 *
 * Layout: `"BRGP" | u32 version | u32 channels | u64 frames | u32 levels`,
 * then per level `u32 binSize | u64 bins | bins × (f32 min, f32 max)`.
 */
export function pyramidLevel(bytes: Uint8Array, level: number): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 24 || String.fromCharCode(...bytes.subarray(0, 4)) !== "BRGP") {
    throw new Error("not a peak pyramid");
  }
  const levels = view.getUint32(20, true);
  let offset = 24;
  for (let index = 0; index < levels; index += 1) {
    const binSize = view.getUint32(offset, true);
    const bins = Number(view.getBigUint64(offset + 4, true));
    const start = offset + 12;
    const end = start + bins * 8;
    if (binSize === level) {
      const out = new Float32Array(bins * 2);
      for (let bin = 0; bin < bins; bin += 1) {
        out[bin * 2] = view.getFloat32(start + bin * 8, true);
        out[bin * 2 + 1] = view.getFloat32(start + bin * 8 + 4, true);
      }
      return out;
    }
    offset = end;
  }
  throw new Error(`peak level ${level} is not in the pyramid`);
}

/**
 * Reads an export frame (`bragi_engine::export::ExportResult::to_frame`), the
 * one binary buffer both hosts use to return encoded files.
 *
 * Layout: `"BXPT" | u32 LE jsonLen | json | file 0 | file 1 | …`, where `json`
 * is `{ version, channels, sampleRate, frames, files: [{ name, length, frames }] }`.
 * The returned files are views into `frame`, not copies.
 */
export function decodeExportFrame(frame: Uint8Array, format: AudioFormat): RenderResult {
  if (
    frame.byteLength < 8 ||
    frame[0] !== 0x42 ||
    frame[1] !== 0x58 ||
    frame[2] !== 0x50 ||
    frame[3] !== 0x54
  ) {
    throw new Error("not an export frame");
  }
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const jsonLength = view.getUint32(4, true);
  if (8 + jsonLength > frame.byteLength) throw new Error("truncated export frame");
  const header = JSON.parse(new TextDecoder().decode(frame.subarray(8, 8 + jsonLength))) as {
    version: number;
    frames: number;
    files: { name: string; length: number; frames: number }[];
  };
  if (header.version !== 1) throw new Error(`unsupported export frame version ${header.version}`);
  let offset = 8 + jsonLength;
  const files: ExportedFile[] = [];
  for (const entry of header.files) {
    if (offset + entry.length > frame.byteLength) throw new Error("truncated export frame");
    files.push({
      name: entry.name,
      bytes: frame.subarray(offset, offset + entry.length),
      frames: entry.frames,
    });
    offset += entry.length;
  }
  return { channels: 2, sampleRate: 48000, format, frames: header.frames, files };
}

/** The format a job asks for; `context` and `cache` have no export format. */
export function jobFormat(job: { kind: string; format?: AudioFormat }): AudioFormat {
  return job.format ?? { container: "wav", bits: 32 };
}
