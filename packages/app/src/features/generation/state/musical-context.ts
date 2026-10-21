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

/** The number of ticks in the bar that contains `tick` (02 §2.2). */
export function ticksPerBarAt(doc: Project, tick: number): number {
  const meter = meterSignatureAt(doc, tick);
  const ppq = doc.arrangement.timebase.ppq;
  return Math.max(1, Math.round((ppq * 4 * meter.numerator) / meter.denominator));
}

/** Seconds elapsed at `tick`; the wasm boundary carries ticks as `bigint`. */
export function secondsAtTick(model: ModelApi, handle: number, tick: number): number {
  return Number(model.ticksToSeconds(handle, BigInt(Math.round(tick))));
}

/** The absolute start tick of every section, in arrangement order. */
export function sectionStarts(doc: Project): number[] {
  const starts: number[] = [];
  let tick = 0;
  for (const section of doc.arrangement.sections) {
    starts.push(tick);
    tick += section.lengthTicks;
  }
  return starts;
}

/** Whether a free-text prompt asks for the song to end ("make an outro"). */
export function asksForEnding(prompt: string | undefined): boolean {
  if (prompt === undefined) return false;
  return /\b(outro|ending|fade[\s-]?out|end the song|finish(es|ing)? the song)\b/i.test(prompt);
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

/** The span and section a capability conditions on (09 §2.1). */
export interface MusicalSpanInput {
  readonly doc: Project;
  readonly model: ModelApi;
  readonly handle: number;
  /** The target span, in absolute ticks: the gap, the boundary's bars or the new section. */
  readonly span: { readonly startTick: number; readonly endTick: number };
  /** The section whose kind travels with the request; default: the one at `span.startTick`. */
  readonly sectionId?: string;
  /** The span the energy is averaged over; default: the target span. */
  readonly energyRange?: { readonly startTick: number; readonly endTick: number };
  readonly seed: number;
  readonly prompt?: string;
  readonly energy?: EnergyCurve;
  readonly readBlob: (hash: string) => Promise<unknown>;
}

/**
 * Builds the {@link MusicalContext} of one request over an explicit target span.
 *
 * Chords are expressed in beats from the span's start, as 09 §2.1 asks. Every capability passes
 * the span it generates into, so an inpaint hears the gap and a transition hears its boundary.
 */
export async function musicalContextForSpan(input: MusicalSpanInput): Promise<MusicalContext> {
  const { doc, model, handle, span } = input;
  const meter = meterSignatureAt(doc, span.startTick);
  const bpm = doc.arrangement.timebase.tempoMap[0]?.bpm ?? 120;
  const secondsPerBeat = 60 / bpm;

  const harmonyHash = Object.values(doc.analyses).find((ref) => ref.blobs.harmony !== undefined)
    ?.blobs.harmony;
  const harmony =
    harmonyHash === undefined
      ? undefined
      : await input.readBlob(harmonyHash).catch(() => undefined);
  const analysis = keyFromAnalysis(doc, harmony);

  const spanStartSec = secondsAtTick(model, handle, span.startTick);
  const spanEndSec = secondsAtTick(model, handle, span.endTick);
  const chords: ChordAtBeat[] = analysis.chords
    .filter((chord) => chord.endSec > spanStartSec && chord.startSec < spanEndSec)
    .map((chord) => ({
      startBeat: Math.round(((chord.startSec - spanStartSec) / secondsPerBeat) * 1000) / 1000,
      symbol: chord.symbol,
    }));

  const kind = sectionKindAt(doc, input.sectionId, span.startTick);
  const energyRange = input.energyRange ?? span;

  return {
    bpm,
    timeSignature: [meter.numerator, meter.denominator],
    key: analysis.key,
    ...(chords.length === 0 ? {} : { chords }),
    ...(kind === undefined ? {} : { sectionKind: kind }),
    ...(input.energy === undefined
      ? {}
      : { energy: meanEnergy(input.energy, energyRange, model, handle) }),
    descriptors: descriptorsFor(doc),
    seed: input.seed,
  };
}

/**
 * Builds the {@link MusicalContext} of one extend request.
 *
 * The target span is the new section: after the song for a forward extend, before it for an intro.
 */
export async function musicalContextFor(input: MusicalContextInput): Promise<MusicalContext> {
  const { doc } = input;
  const total = totalTicks(doc);
  const spanStart = input.direction === "forward" ? total : 0;
  const spanEnd = spanStart + input.bars * ticksPerBarAt(doc, spanStart);
  const sections = doc.arrangement.sections;
  const section = input.direction === "forward" ? sections.at(-1) : sections[0];
  const kind =
    input.direction === "forward" && asksForEnding(input.prompt) ? "outro" : section?.kind;

  const context = await musicalContextForSpan({
    doc,
    model: input.model,
    handle: input.handle,
    span: { startTick: spanStart, endTick: spanEnd },
    ...(section === undefined ? {} : { sectionId: section.id }),
    energyRange: input.contextRange,
    seed: input.seed,
    ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
    ...(input.energy === undefined ? {} : { energy: input.energy }),
    readBlob: input.readBlob,
  });
  // The ending guess is extend's alone: a fill or a transition keeps the section it sits in.
  return kind === context.sectionKind || kind === undefined
    ? context
    : { ...context, sectionKind: kind };
}

/** The kind of the section at `tick`, or of the section with `sectionId`. */
function sectionKindAt(
  doc: Project,
  sectionId: string | undefined,
  tick: number,
): SectionKind | undefined {
  const starts = sectionStarts(doc);
  const index =
    sectionId === undefined
      ? doc.arrangement.sections.findIndex(
          (section, position) =>
            tick >= (starts[position] ?? 0) && tick < (starts[position] ?? 0) + section.lengthTicks,
        )
      : doc.arrangement.sections.findIndex((section) => section.id === sectionId);
  return index >= 0 ? doc.arrangement.sections[index]?.kind : undefined;
}

/** Mean of the energy curve over the context span, 0..1. */
function meanEnergy(
  curve: EnergyCurve,
  range: { readonly startTick: number; readonly endTick: number },
  model: ModelApi,
  handle: number,
): number {
  if (curve.values.length === 0) return 0;
  const startSec = secondsAtTick(model, handle, range.startTick);
  const endSec = secondsAtTick(model, handle, range.endTick);
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
