/**
 * The lasso tool's shape bookkeeping (07 §4.3): the points a free shape passed over and the
 * bounding region it covered. Pure, so the bounds and the covered ribbons are unit-tested without
 * a GPU; {@link SongCanvas} feeds it pointer events and reports the result as `lasso*` events.
 *
 * The region stays in seconds here. Snapping to beats or bars belongs to the app, which owns the
 * tempo map through `bragi-model` (one implementation of seconds ↔ ticks, 02 §2.2).
 */
import type { LassoEvent, LassoPoint, LassoRegion } from "./types.js";

/** Points closer than this on the same ribbon are one point (a pen reports ~240 Hz). */
const MIN_POINT_GAP_SEC = 0.01;

/** A new lasso at its first point. */
export function beginLasso(point: LassoPoint, altKey: boolean): LassoEvent {
  return { points: [point], region: lassoRegion([point]), altKey };
}

/**
 * The lasso with `point` added. A point that repeats the last one (same ribbon, within 10 ms) is
 * dropped, so a pointer resting in place does not grow the shape.
 */
export function extendLasso(lasso: LassoEvent, point: LassoPoint): LassoEvent {
  const last = lasso.points.at(-1);
  if (
    last !== undefined &&
    last.trackId === point.trackId &&
    Math.abs(last.sec - point.sec) < MIN_POINT_GAP_SEC
  ) {
    return lasso;
  }
  const points = [...lasso.points, point];
  return { ...lasso, points, region: lassoRegion(points) };
}

/** The lasso after the `Alt` key changed while the pointer is down. */
export function setLassoAlt(lasso: LassoEvent, altKey: boolean): LassoEvent {
  return lasso.altKey === altKey ? lasso : { ...lasso, altKey };
}

/**
 * The bounding region of a free shape: its earliest and latest time and every ribbon it touched,
 * in first-touch order. An empty shape is a zero-length region with no ribbons.
 */
export function lassoRegion(points: readonly LassoPoint[]): LassoRegion {
  let startSec = Number.POSITIVE_INFINITY;
  let endSec = Number.NEGATIVE_INFINITY;
  const trackIds: string[] = [];
  const seen = new Set<string>();
  for (const point of points) {
    startSec = Math.min(startSec, point.sec);
    endSec = Math.max(endSec, point.sec);
    if (point.trackId !== null && !seen.has(point.trackId)) {
      seen.add(point.trackId);
      trackIds.push(point.trackId);
    }
  }
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) {
    return { startSec: 0, endSec: 0, trackIds };
  }
  return { startSec, endSec, trackIds };
}

/** Whether a lasso covers enough to ask a question: time and at least one ribbon. */
export function lassoHasRegion(region: LassoRegion): boolean {
  return region.endSec > region.startSec && region.trackIds.length > 0;
}
