/**
 * Zoom and pan on the shared time axis (07 §2.1). Pure functions: the canvas class owns the
 * state and calls these.
 *
 * The axis is in seconds and the zoom is in px per *beat*, because that is how 07 names the
 * levels; the two are tied together by the document's tempo.
 */
import type { Viewport, ZoomLevel } from "./types.js";

/** px per beat where each level starts (07 §2.1 table). */
export const LEVEL_THRESHOLDS = { l2: 4, l2Near: 24, l3: 64 } as const;

/** The widest zoom-out and zoom-in the canvas allows, in px per beat. */
export const MIN_PX_PER_BEAT = 0.25;
export const MAX_PX_PER_BEAT = 512;

/** The level for a zoom. Boundaries belong to the higher level (4 -> L2, 24 -> L2-near, 64 -> L3). */
export function zoomLevel(pxPerBeat: number): ZoomLevel {
  if (pxPerBeat < LEVEL_THRESHOLDS.l2) return "L2-far";
  if (pxPerBeat < LEVEL_THRESHOLDS.l2Near) return "L2";
  if (pxPerBeat < LEVEL_THRESHOLDS.l3) return "L2-near";
  return "L3";
}

/** px per second for a zoom and a tempo. */
export function pxPerSecond(pxPerBeat: number, bpm: number): number {
  return (pxPerBeat * bpm) / 60;
}

/** The screen x (relative to the time area's left edge) of a time. */
export function timeToX(viewport: Viewport, bpm: number, sec: number): number {
  return (sec - viewport.originSec) * pxPerSecond(viewport.pxPerBeat, bpm);
}

/** The time at a screen x (relative to the time area's left edge). */
export function xToTime(viewport: Viewport, bpm: number, x: number): number {
  return viewport.originSec + x / pxPerSecond(viewport.pxPerBeat, bpm);
}

/** The seconds visible across `widthPx`. */
export function visibleSeconds(viewport: Viewport, bpm: number, widthPx: number): number {
  return widthPx / pxPerSecond(viewport.pxPerBeat, bpm);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Keeps the viewport inside the song: you can pan until the song's end touches the right edge,
 * and a song shorter than the window is pinned at 0.
 */
export function clampViewport(
  viewport: Viewport,
  bpm: number,
  durationSec: number,
  widthPx: number,
): Viewport {
  const pxPerBeat = clamp(viewport.pxPerBeat, MIN_PX_PER_BEAT, MAX_PX_PER_BEAT);
  const span = visibleSeconds({ pxPerBeat, originSec: 0 }, bpm, widthPx);
  const maxOrigin = Math.max(0, durationSec - span);
  return { pxPerBeat, originSec: clamp(viewport.originSec, 0, maxOrigin) };
}

/**
 * Zooms by `factor` keeping the time under `anchorX` where it is (07 §2.1: "Zoom is anchored at
 * the cursor").
 */
export function zoomAt(
  viewport: Viewport,
  bpm: number,
  durationSec: number,
  widthPx: number,
  factor: number,
  anchorX: number,
): Viewport {
  const anchorSec = xToTime(viewport, bpm, anchorX);
  const pxPerBeat = clamp(viewport.pxPerBeat * factor, MIN_PX_PER_BEAT, MAX_PX_PER_BEAT);
  const originSec = anchorSec - anchorX / pxPerSecond(pxPerBeat, bpm);
  return clampViewport({ pxPerBeat, originSec }, bpm, durationSec, widthPx);
}

/** Pans by a pixel delta (positive `dx` moves the content right, i.e. earlier times appear). */
export function panBy(
  viewport: Viewport,
  bpm: number,
  durationSec: number,
  widthPx: number,
  dx: number,
): Viewport {
  const originSec = viewport.originSec - dx / pxPerSecond(viewport.pxPerBeat, bpm);
  return clampViewport({ ...viewport, originSec }, bpm, durationSec, widthPx);
}

/** The viewport that shows the whole song (key `F`, 07 §3). */
export function fitSong(bpm: number, durationSec: number, widthPx: number): Viewport {
  if (durationSec <= 0 || widthPx <= 0) return { pxPerBeat: 8, originSec: 0 };
  const pxPerBeat = clamp((widthPx / durationSec) * (60 / bpm), MIN_PX_PER_BEAT, MAX_PX_PER_BEAT);
  return { pxPerBeat, originSec: 0 };
}

/**
 * Keeps `sec` in view by panning the least amount (follow-playhead), with `marginPx` of room at
 * the right edge.
 */
export function revealTime(
  viewport: Viewport,
  bpm: number,
  durationSec: number,
  widthPx: number,
  sec: number,
  marginPx = 48,
): Viewport {
  const x = timeToX(viewport, bpm, sec);
  if (x >= 0 && x <= widthPx - marginPx) return viewport;
  const secPerPx = 1 / pxPerSecond(viewport.pxPerBeat, bpm);
  const originSec = sec - widthPx * 0.25 * secPerPx;
  return clampViewport({ ...viewport, originSec }, bpm, durationSec, widthPx);
}

/**
 * The envelope resolution to draw at a zoom: about 1-2 bins per pixel (07 §9), capped by what
 * the data has. Returned as bins per second, snapped to a power of two so the geometry is rebuilt
 * only when the zoom crosses a step, not on every frame of a zoom gesture.
 */
export function lodBinsPerSecond(pxPerSec: number, dataBinsPerSec: number): number {
  const wanted = Math.max(1, pxPerSec * 1.5);
  const stepped = 2 ** Math.ceil(Math.log2(wanted));
  return Math.min(stepped, dataBinsPerSec > 0 ? dataBinsPerSec : stepped);
}
