/**
 * The musical facts of an extend request (09 §2.1).
 *
 * The generator gets what the model must conform to: the song's tempo and meter, the key and the
 * chords of the target span, the section kind it continues, an energy target and style
 * descriptors. Everything comes from the document and the analysis the document records, never
 * from a model call. Artist names are not extracted here: the prompt travels as `params.prompt`
 * and the server applies the fusion policy (10 §7; see the deviation in `docs/wp/2.7.md`).
 */

import type {
  ChordAtBeat,
  GenerateExtendParams,
  MusicalContext,
  MusicalKey,
  Project,
  SectionKind,
} from "@bragi/schemas";
import { validateHarmonyResult } from "@bragi/schemas";
import type { ModelApi } from "../../song/model/model-api.js";

/** A bar of the song at a tick, when the meter can change (02 §2.2). */
export interface MeterSignature {
  readonly numerator: number;
  readonly denominator: number;
}

/** The energy curve the canvas already has (`LoudnessEnergyResult.energy`). */
export interface EnergyCurve {
  readonly values: ArrayLike<number>;
  readonly hopSec: number;
}

export interface MusicalContextInput {
  readonly doc: Project;
  readonly model: ModelApi;
  /** The document's model handle, for tick → seconds. */
  readonly handle: number;
  readonly direction: GenerateExtendParams["direction"];
  readonly contextRange: { readonly startTick: number; readonly endTick: number };
  readonly bars: number;
  readonly seed: number;
  readonly prompt?: string;
  /** The live energy skyline, when the analysis has it. */
  readonly energy?: EnergyCurve;
  /** Reads a blob the document records (the harmony result). */
  readonly readBlob: (hash: string) => Promise<unknown>;
}

/**
 * The time signature at `tick`: the last signature whose bar starts at or before that bar.
 *
 * Bar lengths can change, so the signature list is walked from bar 0 with each signature's own
 * length, exactly like `bragi-model`'s bar math.
 */
export function meterSignatureAt(doc: Project, tick: number): MeterSignature {
  const { ppq, timeSignatures } = doc.arrangement.timebase;
  const signatures = [...timeSignatures].sort((a, b) => a.bar - b.bar);
  let bar = 0;
  let startTick = 0;
  let current = { numerator: 4, denominator: 4 };
  for (const [index, signature] of signatures.entries()) {
    const ticksPerBar = Math.max(
      1,
      Math.round((ppq * 4 * signature.numerator) / signature.denominator),
    );
    const next = signatures[index + 1];
    const segmentEnd =
      startTick + Math.max(0, (next?.bar ?? Number.POSITIVE_INFINITY) - bar) * ticksPerBar;
    if (next === undefined || tick < segmentEnd) {
      current = { numerator: signature.numerator, denominator: signature.denominator };
      return current;
    }
    bar = next.bar;
    startTick = segmentEnd;
  }
  return current;
}

/** The sum of the sections' lengths; sections are contiguous (02 §3.5). */
export function totalTicks(doc: Project): number {
  return doc.arrangement.sections.reduce((sum, section) => sum + section.lengthTicks, 0);
}

/** Whether a free-text prompt asks for the song to end ("make an outro"). */
export function asksForEnding(prompt: string | undefined): boolean {
  if (prompt === undefined) return false;
  return /\b(outro|ending|fade[\s-]?out|end the song|finish(es|ing)? the song)\b/i.test(prompt);
}

/** Seconds elapsed at `tick`; the wasm boundary carries ticks as `bigint`. */
function secondsAt(model: ModelApi, handle: number, tick: number): number {
  return Number(model.ticksToSeconds(handle, BigInt(Math.round(tick))));
}

/** The key the analysis heard, from the harmony blob or the summary line. */
function keyFromAnalysis(
  doc: Project,
  harmony: unknown,
): { key: MusicalKey; chords: readonly { startSec: number; endSec: number; symbol: string }[] } {
  if (validateHarmonyResult(harmony)) {
    return {
      key: { tonic: harmony.key.tonic, mode: harmony.key.mode },
      chords: harmony.chords,
    };
  }
  for (const ref of Object.values(doc.analyses)) {
    const key = ref.summary?.key;
    if (key === undefined) continue;
    const match = /^([A-Ga-g][#b♯♭]?)\s+(major|minor)/i.exec(key.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) {
      return {
        key: {
          tonic: match[1].toUpperCase(),
          mode: match[2].toLowerCase() === "minor" ? "minor" : "major",
        },
        chords: [],
      };
    }
  }
  // A song extended before harmony analysis landed still needs a key; the model is told C major,
  // which the key gate then checks against what it generates (09 §6).
  return { key: { tonic: "C", mode: "major" }, chords: [] };
}

/**
 * Builds the {@link MusicalContext} of one extend request.
 *
 * Chords are expressed in beats from the target span's start, as 09 §2.1 asks. The target span is
 * the new section: after the song for a forward extend, before it for an intro.
 */
export async function musicalContextFor(input: MusicalContextInput): Promise<MusicalContext> {
  const { doc, model, handle, direction } = input;
  const total = totalTicks(doc);
  const spanStart = direction === "forward" ? total : 0;
  const meter = meterSignatureAt(doc, spanStart);
  const ticksPerBar = Math.max(
    1,
    Math.round((doc.arrangement.timebase.ppq * 4 * meter.numerator) / meter.denominator),
  );
  const spanEnd = spanStart + input.bars * ticksPerBar;
  const bpm = doc.arrangement.timebase.tempoMap[0]?.bpm ?? 120;
  const secondsPerBeat = 60 / bpm;

  const harmonyHash = Object.values(doc.analyses).find((ref) => ref.blobs.harmony !== undefined)
    ?.blobs.harmony;
  const harmony =
    harmonyHash === undefined
      ? undefined
      : await input.readBlob(harmonyHash).catch(() => undefined);
  const analysis = keyFromAnalysis(doc, harmony);

  const spanStartSec = secondsAt(model, handle, spanStart);
  const spanEndSec = secondsAt(model, handle, spanEnd);
  const chords: ChordAtBeat[] = analysis.chords
    .filter((chord) => chord.endSec > spanStartSec && chord.startSec < spanEndSec)
    .map((chord) => ({
      startBeat: Math.round(((chord.startSec - spanStartSec) / secondsPerBeat) * 1000) / 1000,
      symbol: chord.symbol,
    }));

  const sections = doc.arrangement.sections;
  const section = direction === "forward" ? sections.at(-1) : sections[0];
  const kind: SectionKind | undefined =
    direction === "forward" && asksForEnding(input.prompt) ? "outro" : section?.kind;

  return {
    bpm,
    timeSignature: [meter.numerator, meter.denominator],
    key: analysis.key,
    ...(chords.length === 0 ? {} : { chords }),
    ...(kind === undefined ? {} : { sectionKind: kind }),
    ...(input.energy === undefined
      ? {}
      : { energy: meanEnergy(input.energy, input.contextRange, model, handle) }),
    descriptors: descriptorsFor(doc),
    seed: input.seed,
  };
}

/** Mean of the energy curve over the context span, 0..1. */
function meanEnergy(
  curve: EnergyCurve,
  range: { readonly startTick: number; readonly endTick: number },
  model: ModelApi,
  handle: number,
): number {
  if (curve.values.length === 0) return 0;
  const startSec = secondsAt(model, handle, range.startTick);
  const endSec = secondsAt(model, handle, range.endTick);
  const first = Math.max(0, Math.floor(startSec / curve.hopSec));
  const last = Math.min(curve.values.length - 1, Math.ceil(endSec / curve.hopSec));
  let sum = 0;
  let count = 0;
  for (let index = first; index <= last; index += 1) {
    sum += curve.values[index] ?? 0;
    count += 1;
  }
  return count === 0 ? 0 : Math.max(0, Math.min(1, sum / count));
}

/** The document's tags, as the style descriptors of 09 §2.1. */
function descriptorsFor(doc: Project): string[] {
  return [...new Set(doc.meta.tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0))].slice(
    0,
    12,
  );
}
