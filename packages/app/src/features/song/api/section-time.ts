/**
 * Section spans in seconds (02 §3.5, §8): the model derives the ticks, the tempo map converts them,
 * and this module is the seam the UI uses for looping a part and finding the part at the playhead.
 */
import type { ModelApi } from "../model/model-api.js";

interface SpanJson {
  readonly id: string;
  readonly index: number;
  readonly startTick: number;
  readonly endTick: number;
  readonly lengthTicks: number;
}

export interface SectionSpanSec {
  readonly id: string;
  readonly index: number;
  readonly startTick: number;
  readonly endTick: number;
  readonly startSec: number;
  readonly endSec: number;
}

/** Every section span, in arrangement order, with seconds from the model's tempo map. */
export function sectionSpansSec(model: ModelApi, handle: number): SectionSpanSec[] {
  const spans = JSON.parse(model.sectionSpans(handle)) as SpanJson[];
  return spans.map((span) => ({
    id: span.id,
    index: span.index,
    startTick: span.startTick,
    endTick: span.endTick,
    startSec: model.ticksToSeconds(handle, BigInt(span.startTick)),
    endSec: model.ticksToSeconds(handle, BigInt(span.endTick)),
  }));
}

/**
 * Absolute ticks at an arrangement time, through the model's tempo map (02 §2.2).
 *
 * The canvas reports paint points in seconds; the brush model works in ticks. Going through the
 * model keeps one implementation of the tempo-map maths for every caller (07 §4.4).
 */
export function ticksAtSeconds(model: ModelApi, handle: number, sec: number): number {
  return Number(model.secondsToTicks(handle, sec));
}

/** Arrangement seconds at an absolute tick, through the model's tempo map. */
export function secondsAtTicks(model: ModelApi, handle: number, tick: number): number {
  return model.ticksToSeconds(handle, BigInt(Math.round(tick)));
}

/** One section's span in seconds, or `null` when it is gone. */
export function sectionSpanSec(
  model: ModelApi,
  handle: number,
  sectionId: string,
): SectionSpanSec | null {
  return sectionSpansSec(model, handle).find((span) => span.id === sectionId) ?? null;
}

/** The section containing an absolute tick, matching how `sectionSpans` lays them out. */
export function sectionAtTick(
  spans: readonly SectionSpanSec[],
  tick: number,
): SectionSpanSec | null {
  return spans.find((span) => tick >= span.startTick && tick < span.endTick) ?? null;
}
