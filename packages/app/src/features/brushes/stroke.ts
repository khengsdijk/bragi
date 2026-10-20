/**
 * Stroke → region and strength (07 §4.4, WP-2.4).
 *
 * A stroke snaps to sixteenth notes and the ribbons it touched, in the order they were touched:
 * that is the region every brush then paints into (02 §3.8). The strength is the mean pen
 * pressure; a mouse has no pressure, so it contributes the brush-size slider (or `0.5`, what
 * browsers report), and the wheel nudges it in steps of `0.1` while painting.
 */
import type { Region } from "@bragi/schemas";

import type { Stroke } from "./types.js";

/** Ticks per quarter note (02 §2.2). */
const PPQ = 960;

/** A sixteenth note: the paint stroke's snap grid (07 §4.4). */
export const STROKE_SNAP_TICKS = PPQ / 4;

/** One wheel notch, as a fraction of the strength range. */
const WHEEL_STEP = 0.1;

/** The pressure a mouse reports when the browser has no better answer. */
const MOUSE_PRESSURE = 0.5;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * The region a stroke covers: its tick span snapped outwards to sixteenth notes, and the distinct
 * track ids in the order the pointer first touched them.
 *
 * The span rounds outwards so the painted area is always fully covered and never collapses to
 * zero ticks. An empty stroke has no region.
 */
export function strokeRegion(stroke: Stroke): Region | null {
  const ticks = stroke.points.map((point) => point.tick).filter((tick) => Number.isFinite(tick));
  if (ticks.length === 0) return null;

  const startTick = Math.max(
    0,
    Math.floor(Math.min(...ticks) / STROKE_SNAP_TICKS) * STROKE_SNAP_TICKS,
  );
  const endTick = Math.max(
    startTick + STROKE_SNAP_TICKS,
    Math.ceil(Math.max(...ticks) / STROKE_SNAP_TICKS) * STROKE_SNAP_TICKS,
  );

  const tracks: string[] = [];
  for (const point of stroke.points) {
    if (!tracks.includes(point.trackId)) tracks.push(point.trackId);
  }
  return { startTick, endTick, tracks };
}

/**
 * The strength of a stroke in `0..1`.
 *
 * Pen pressure is averaged over the points; a mouse has no pressure, so the size slider is the
 * strength (and `0.5` when the caller did not pass one). Wheel notches accumulated during the
 * stroke add `0.1` each, so scrolling up deepens the effect and scrolling down softens it.
 */
export function strokeStrength(stroke: Stroke): number {
  const pressures = stroke.points.map((point) => point.pressure).filter(Number.isFinite);
  const mean =
    pressures.length === 0
      ? (stroke.sizeStrength ?? 0)
      : pressures.reduce((sum, pressure) => sum + pressure, 0) / pressures.length;

  const base = stroke.pointerType === "mouse" ? (stroke.sizeStrength ?? MOUSE_PRESSURE) : mean;
  return clamp01(base + (stroke.wheelDelta ?? 0) * WHEEL_STEP);
}
