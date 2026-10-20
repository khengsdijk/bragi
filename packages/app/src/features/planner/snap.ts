/**
 * The lasso's seconds region → the tick region the planner gets (07 §4.3).
 *
 * Snapping happens in the app, not the canvas, because the tempo map lives in `bragi-model`
 * (`ticksAtSeconds`). A shape snaps to beats, or to whole bars when it spans more than two bars;
 * `Alt` disables snapping and keeps the tick link. Pure apart from the two injected conversions,
 * so the rule is unit-tested without the model.
 */
import type { Region } from "@bragi/schemas";

export interface LassoSnapInput {
  readonly startSec: number;
  readonly endSec: number;
  readonly trackIds: readonly string[];
  /** `Alt` at release: no grid snapping (07 §4.3). */
  readonly altKey: boolean;
  readonly bpm: number;
  readonly beatsPerBar: number;
  readonly ppq: number;
  /** The song's last tick, so a snapped edge never lands outside it. */
  readonly totalTicks: number;
  /** `bragi-model`'s tempo-map conversion, from `features/song/api/section-time.ts`. */
  readonly ticksAtSeconds: (sec: number) => number;
  readonly secondsAtTicks: (tick: number) => number;
}

export interface SnappedLasso {
  readonly region: Region;
  /** The snapped region in seconds, for the canvas overlay and the auto-loop. */
  readonly startSec: number;
  readonly endSec: number;
}

/** Where a lasso should snap: beats, bars above two bars, or nothing with Alt. */
export function lassoSpanBars(
  input: Pick<LassoSnapInput, "bpm" | "beatsPerBar" | "startSec" | "endSec">,
): number {
  const secondsPerBar = (60 / input.bpm) * input.beatsPerBar;
  if (!Number.isFinite(secondsPerBar) || secondsPerBar <= 0) return 0;
  return Math.max(0, input.endSec - input.startSec) / secondsPerBar;
}

/**
 * Snaps a lasso to the grid.
 *
 * - Alt: the rounded ticks, no grid.
 * - More than two bars: whole bars.
 * - Otherwise: beats.
 *
 * A collapse after rounding grows the region by one step, so a tiny lasso still covers something.
 */
export function snapLassoRegion(input: LassoSnapInput): SnappedLasso {
  const total = Math.max(0, Math.round(input.totalTicks));
  const rawStart = clamp(Math.round(input.ticksAtSeconds(input.startSec)), 0, total);
  const rawEnd = clamp(Math.round(input.ticksAtSeconds(input.endSec)), 0, total);
  const from = Math.min(rawStart, rawEnd);
  const to = Math.max(rawStart, rawEnd);
  const beats = Math.max(1, Math.round(input.beatsPerBar));
  const beatTicks = Math.max(1, Math.round(input.ppq));
  const step = input.altKey ? 1 : lassoSpanBars(input) > 2 ? beatTicks * beats : beatTicks;
  let startTick = input.altKey ? from : Math.round(from / step) * step;
  let endTick = input.altKey ? to : Math.round(to / step) * step;
  startTick = clamp(startTick, 0, total);
  endTick = clamp(endTick, 0, total);
  if (endTick <= startTick) endTick = Math.min(total, startTick + step);
  if (endTick <= startTick) startTick = Math.max(0, endTick - step);
  const trackIds = [...new Set(input.trackIds)];
  return {
    region: { startTick, endTick, tracks: trackIds },
    startSec: input.secondsAtTicks(startTick),
    endSec: input.secondsAtTicks(endTick),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(min, value), max);
}
