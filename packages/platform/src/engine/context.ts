/**
 * `renderContext`: generation conditioning audio for the extend flow
 * (specs/03-audio-engine.md §9, specs/09-generation.md §3).
 *
 * The engine converts the tick range through the tempo map and cuts it
 * sample-exactly; this wrapper only fails fast on a range the document cannot
 * contain, so the app gets a typed error before a worker round trip. The
 * result is the single 48 kHz, 32-bit float stereo `context.wav`.
 */
import type { EngineHost, ProjectJson } from "./types.js";

/** A half-open tick range (`bragi-model`'s `TickRange`). */
export interface ContextRange {
  readonly startTick: number;
  readonly endTick: number;
}

/** The file the engine returns for a `context` job. */
export const CONTEXT_FILE_NAME = "context.wav";

/**
 * Renders `range` of `doc` (all tracks by default) to WAV bytes.
 *
 * Validation is the document's total tick length, not the tempo map: the
 * engine owns tick -> sample conversion (`bragi_model::TempoCtx`). Throws a
 * `RangeError` for a non-integer, empty, inverted or out-of-song range or an
 * empty track list, and an `Error` if the engine returns an unexpected file.
 */
export async function renderContext(
  host: EngineHost,
  doc: ProjectJson,
  range: ContextRange,
  tracks: readonly string[] | "all" = "all",
): Promise<Uint8Array> {
  const total = totalTicks(doc);
  if (!Number.isInteger(range.startTick) || !Number.isInteger(range.endTick)) {
    throw new RangeError(`tick range ${range.startTick}..${range.endTick} must be whole ticks`);
  }
  if (range.endTick <= range.startTick) {
    throw new RangeError(
      `empty or inverted tick range: start ${range.startTick}, end ${range.endTick}`,
    );
  }
  if (range.startTick < 0 || range.endTick > total) {
    throw new RangeError(
      `tick range ${range.startTick}..${range.endTick} is outside the song (0..${total})`,
    );
  }
  if (tracks !== "all" && tracks.length === 0) {
    throw new RangeError("the track list is empty");
  }

  const result = await host.render({ kind: "context", range, tracks });
  const file = result.files[0];
  if (file === undefined || file.name !== CONTEXT_FILE_NAME) {
    throw new Error(
      `the engine returned ${result.files.map((entry) => entry.name).join(", ") || "no file"} for a context render`,
    );
  }
  return file.bytes;
}

/** The sum of the sections' `lengthTicks`; sections are contiguous by contract. */
function totalTicks(doc: ProjectJson): number {
  const arrangement = doc.arrangement;
  if (typeof arrangement !== "object" || arrangement === null) {
    throw new RangeError("the document has no arrangement");
  }
  const sections = (arrangement as { readonly sections?: unknown }).sections;
  if (!Array.isArray(sections)) throw new RangeError("the document has no sections");
  let total = 0;
  for (const section of sections) {
    if (typeof section !== "object" || section === null) continue;
    const length = (section as { readonly lengthTicks?: unknown }).lengthTicks;
    if (typeof length !== "number" || !Number.isFinite(length)) {
      throw new RangeError("a section has no numeric lengthTicks");
    }
    total += length;
  }
  return total;
}
