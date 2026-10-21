/**
 * Bar-aligned context windows around a gap or a boundary (09 §4.3–4.4, §2).
 *
 * Generation speaks bars, not seconds: an inpaint's context ends on the bar line where its gap
 * starts, and a transition's two sides meet on the section boundary. The windows are walked from
 * the document's own meter so a time-signature change moves them with it, and are clamped to the
 * song. `bragi-model` owns the same maths for the song edges (`barAlignedContextRange`); these
 * take an arbitrary tick because a gap is not at an edge.
 */
import type { ContextRange } from "@bragi/platform";
import type { Project, Region } from "@bragi/schemas";
import type { ModelApi } from "../../song/model/model-api.js";
import { meterAt } from "../../song/state/section-ops.js";
import { meterSignatureAt, secondsAtTick, ticksPerBarAt, totalTicks } from "./musical-context.js";

/** The smallest context a two-sided capability can be given: one bar. */
export interface BarRange {
  readonly startTick: number;
  readonly endTick: number;
}

/** What the windows need from the song: the model handle and its sample clock. */
export interface WindowGeometry {
  readonly model: ModelApi;
  readonly handle: number;
}

/** Seconds between two ticks, through the tempo map. */
export function secondsBetween(
  geometry: WindowGeometry,
  startTick: number,
  endTick: number,
): number {
  return Math.abs(
    secondsAtTick(geometry.model, geometry.handle, endTick) -
      secondsAtTick(geometry.model, geometry.handle, startTick),
  );
}

/** Samples between two ticks at 48 kHz (09 §4.3's offsets are in samples). */
export function samplesBetween(
  geometry: WindowGeometry,
  startTick: number,
  endTick: number,
): number {
  return Math.max(0, Math.round(secondsBetween(geometry, startTick, endTick) * 48_000));
}

/** The bar containing `tick`, from the document's meter map. */
export function barAt(doc: Project, tick: number): BarRange & { ticksPerBar: number } {
  const meter = meterAt(doc, Math.max(0, tick));
  return {
    startTick: meter.startTick,
    endTick: meter.startTick + meter.ticksPerBar,
    ticksPerBar: meter.ticksPerBar,
  };
}

/**
 * The erased region snapped inward to whole bars (06 §3, 09 §4.3): the gap must lie inside what
 * the user erased, so a partial bar at either end is not filled. A region inside one bar is
 * widened to that bar, because a gap smaller than a bar is not something the worker can generate.
 */
export function snapRegionToBars(doc: Project, region: Region): BarRange {
  const total = totalTicks(doc);
  const startTick = Math.max(0, Math.min(total, region.startTick));
  const endTick = Math.max(0, Math.min(total, region.endTick));
  const startBar = barAt(doc, startTick);
  const endBar = barAt(doc, Math.max(startTick, endTick - 1));
  const snappedStart = startTick === startBar.startTick ? startTick : startBar.endTick;
  const snappedEnd = endTick === endBar.endTick ? endTick : endBar.startTick;
  if (snappedEnd <= snappedStart) {
    return { startTick: startBar.startTick, endTick: Math.min(total, startBar.endTick) };
  }
  return { startTick: snappedStart, endTick: snappedEnd };
}

/** Every bar line in `[0, total]`, as start ticks (02 §2.2). */
export function barLines(doc: Project): number[] {
  const total = totalTicks(doc);
  const lines: number[] = [0];
  let tick = 0;
  while (tick < total) {
    const meter = meterSignatureAt(doc, tick);
    const ticks = Math.max(
      1,
      Math.round((doc.arrangement.timebase.ppq * 4 * meter.numerator) / meter.denominator),
    );
    tick += ticks;
    lines.push(Math.min(tick, total));
  }
  return [...new Set(lines)].sort((a, b) => a - b);
}

/**
 * A bar-aligned window of at most `maxSec` that ends at `endTick`.
 *
 * Walks whole bars backwards and stops before the bar that would cross the bound; at least one bar
 * is always returned so a very slow song still has context. Clamped to the song's start.
 */
export function rangeEndingAt(
  doc: Project,
  geometry: WindowGeometry,
  endTick: number,
  maxSec: number,
): ContextRange {
  const lines = barLines(doc).filter((line) => line < endTick);
  const end = Math.max(0, Math.min(totalTicks(doc), endTick));
  let start = end;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = lines[index];
    if (candidate === undefined) break;
    const span = secondsBetween(geometry, candidate, end);
    if (span > maxSec && start < end) break;
    start = candidate;
    if (span > maxSec) break;
  }
  return { startTick: start, endTick: end };
}

/** A bar-aligned window of at most `maxSec` that starts at `startTick`. */
export function rangeStartingAt(
  doc: Project,
  geometry: WindowGeometry,
  startTick: number,
  maxSec: number,
): ContextRange {
  const total = totalTicks(doc);
  const lines = barLines(doc).filter((line) => line > startTick);
  const start = Math.max(0, Math.min(total, startTick));
  let end = start;
  for (const candidate of lines) {
    const span = secondsBetween(geometry, start, candidate);
    if (span > maxSec && end > start) break;
    end = candidate;
    if (span > maxSec) break;
  }
  return { startTick: start, endTick: Math.min(total, end) };
}

/** `count` whole bars ending at `endTick`, clamped to the song's start. */
export function barsEndingAt(doc: Project, endTick: number, count: number): ContextRange {
  const lines = barLines(doc).filter((line) => line < endTick);
  const start = lines[Math.max(0, lines.length - Math.max(1, count))] ?? 0;
  return { startTick: start, endTick: Math.max(start, endTick) };
}

/** `count` whole bars starting at `startTick`, clamped to the song's end. */
export function barsStartingAt(doc: Project, startTick: number, count: number): ContextRange {
  const total = totalTicks(doc);
  const lines = barLines(doc).filter((line) => line > startTick);
  const start = Math.max(0, Math.min(total, startTick));
  const end = lines[Math.min(lines.length - 1, Math.max(0, count - 1))] ?? total;
  return { startTick: start, endTick: Math.min(total, Math.max(start, end)) };
}

/** The bar count of a gap, rounded to the nearest whole bar (it is snapped first). */
export function gapBars(doc: Project, range: BarRange): number {
  const ticks = Math.max(1, ticksPerBarAt(doc, range.startTick));
  return Math.max(1, Math.round((range.endTick - range.startTick) / ticks));
}
