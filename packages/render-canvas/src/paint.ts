/**
 * The paint tool's stroke bookkeeping (07 §4.4): the points a stroke passed over and the span the
 * canvas draws for it. Pure, so the stroke's shape is unit-tested without a GPU; {@link SongCanvas}
 * feeds it pointer events and reports the stroke to the app as `paint*` events.
 */
import type { PaintPoint, PaintStrokeEvent } from "./types.js";

/** Points closer than this in time on the same ribbon are one point (a pen reports ~240 Hz). */
const MIN_POINT_GAP_SEC = 0.01;

/** The pressure a mouse stroke reports: browsers give 0.5 while a button is down. */
export const MOUSE_PRESSURE = 0.5;

/** The faintest stroke the canvas draws, so even a light touch stays visible (07 §4.4). */
export const MIN_PAINT_OPACITY = 0.15;

/** One wheel notch as a fraction of the strength range. */
const WHEEL_STEP = 0.1;

/** A new stroke at its first point. */
export function beginPaintStroke(
  point: PaintPoint,
  pointerType: PaintStrokeEvent["pointerType"],
): PaintStrokeEvent {
  return { points: [point], wheelDelta: 0, pointerType };
}

/**
 * The stroke with `point` added. A point that repeats the last one (same ribbon, within 10 ms)
 * only updates its pressure, so a pen resting in place does not grow the stroke.
 */
export function extendPaintStroke(stroke: PaintStrokeEvent, point: PaintPoint): PaintStrokeEvent {
  const last = stroke.points.at(-1);
  if (
    last !== undefined &&
    last.trackId === point.trackId &&
    Math.abs(last.sec - point.sec) < MIN_POINT_GAP_SEC
  ) {
    if (last.pressure === point.pressure) return stroke;
    return {
      ...stroke,
      points: [...stroke.points.slice(0, -1), { ...last, pressure: point.pressure }],
    };
  }
  return { ...stroke, points: [...stroke.points, point] };
}

/** The stroke after `notches` wheel steps (positive is stronger). */
export function nudgePaintStroke(stroke: PaintStrokeEvent, notches: number): PaintStrokeEvent {
  return notches === 0 ? stroke : { ...stroke, wheelDelta: stroke.wheelDelta + notches };
}

/** What the canvas shades: the stroke's time span and the ribbons it touched. */
export function paintSpan(stroke: PaintStrokeEvent): {
  readonly startSec: number;
  readonly endSec: number;
  readonly tracks: ReadonlySet<string>;
} {
  let startSec = Number.POSITIVE_INFINITY;
  let endSec = Number.NEGATIVE_INFINITY;
  const tracks = new Set<string>();
  for (const point of stroke.points) {
    startSec = Math.min(startSec, point.sec);
    endSec = Math.max(endSec, point.sec);
    tracks.add(point.trackId);
  }
  return { startSec, endSec, tracks };
}

/** The mean pressure of a stroke's points, or `null` when it has none. */
function meanPressure(stroke: PaintStrokeEvent): number | null {
  const pressures = stroke.points.map((point) => point.pressure).filter(Number.isFinite);
  if (pressures.length === 0) return null;
  return pressures.reduce((sum, pressure) => sum + pressure, 0) / pressures.length;
}

/**
 * How opaque the canvas draws a stroke in `0..1` (07 §4.4): the mean pen pressure, or the brush
 * size slider for a mouse, plus `0.1` per wheel notch. The result is floored at
 * {@link MIN_PAINT_OPACITY} so a light touch still shows where the stroke is.
 */
export function paintOpacity(stroke: PaintStrokeEvent, sizeStrength: number): number {
  const pressure = meanPressure(stroke);
  const base = stroke.pointerType === "mouse" ? sizeStrength : (pressure ?? sizeStrength);
  const value = base + stroke.wheelDelta * WHEEL_STEP;
  return Math.min(1, Math.max(MIN_PAINT_OPACITY, value));
}

/**
 * Wheel notches from a wheel event: browsers report pixels (100 per notch), lines (3 per notch)
 * or pages. Scrolling up is positive, so it deepens the stroke.
 */
export function wheelNotches(deltaY: number, deltaMode: number): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 0;
  const perNotch = deltaMode === 1 ? 3 : 100;
  return Math.max(-3, Math.min(3, -deltaY / perNotch));
}
