/**
 * Geometry builders (07 §9): the skyline's Catmull-Rom outline, curve resampling to about one to
 * two bins per pixel, culling windows, and the triangle-strip ribbon meshes. All of it is plain
 * typed-array maths with no GPU object in sight, so it is unit-tested in Node and benchmarked
 * without a browser.
 */
import type { Curve, PeakWindow } from "./types.js";
import { pxPerSecond } from "./viewport.js";

/** The value of `curve` at time `sec`, linearly interpolated and clamped at the ends. */
export function sampleCurve(curve: Curve, sec: number): number {
  const n = curve.values.length;
  if (n === 0) return 0;
  const position = sec / curve.hopSec;
  if (position <= 0) return curve.values[0] ?? 0;
  if (position >= n - 1) return curve.values[n - 1] ?? 0;
  const index = Math.floor(position);
  const fraction = position - index;
  const a = curve.values[index] ?? 0;
  const b = curve.values[index + 1] ?? a;
  return a + (b - a) * fraction;
}

/**
 * Resamples `curve` to `count` bins of `1 / binsPerSecond` seconds starting at `startSec`.
 *
 * Where a bin covers several source values the **maximum** is kept (so a short loud hit does not
 * vanish when zoomed out); where it covers less than one the value is interpolated.
 */
export function resampleCurve(
  curve: Curve,
  startSec: number,
  binsPerSecond: number,
  count: number,
): Float32Array {
  const out = new Float32Array(count);
  const dt = 1 / binsPerSecond;
  const n = curve.values.length;
  if (n === 0) return out;
  const hop = curve.hopSec;
  for (let bin = 0; bin < count; bin += 1) {
    const t0 = startSec + bin * dt;
    const first = Math.floor(t0 / hop);
    const last = Math.ceil((t0 + dt) / hop);
    if (last - first <= 1) {
      out[bin] = sampleCurve(curve, t0 + dt / 2);
      continue;
    }
    let max = 0;
    const from = Math.max(0, first);
    const to = Math.min(n - 1, last);
    for (let index = from; index <= to; index += 1) {
      const value = curve.values[index] ?? 0;
      if (value > max) max = value;
    }
    out[bin] = max;
  }
  return out;
}

/**
 * Catmull-Rom through `points` (interleaved x, y), `steps` segments between each pair.
 * Returns interleaved x, y. The curve passes through every input point (07 §2: "smoothed").
 */
export function catmullRom(points: Float32Array, steps: number): Float32Array {
  const count = points.length / 2;
  if (count < 3 || steps < 2) return points;
  const out = new Float32Array(((count - 1) * steps + 1) * 2);
  let write = 0;
  const px = (i: number): number => points[Math.min(count - 1, Math.max(0, i)) * 2] ?? 0;
  const py = (i: number): number => points[Math.min(count - 1, Math.max(0, i)) * 2 + 1] ?? 0;
  for (let i = 0; i < count - 1; i += 1) {
    for (let s = 0; s < steps; s += 1) {
      const t = s / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      const blend = (p0: number, p1: number, p2: number, p3: number): number =>
        0.5 *
        (2 * p1 +
          (-p0 + p2) * t +
          (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
          (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
      out[write] = blend(px(i - 1), px(i), px(i + 1), px(i + 2));
      out[write + 1] = blend(py(i - 1), py(i), py(i + 1), py(i + 2));
      write += 2;
    }
  }
  out[write] = px(count - 1);
  out[write + 1] = py(count - 1);
  return out;
}

export interface SkylineOutline {
  /** Interleaved x, y of the top edge, left to right; `y` is measured down from the lane top. */
  readonly top: Float32Array;
}

/**
 * The skyline's top edge for the window starting at `startSec`: `count` bins at `binsPerSecond`,
 * x in world px at `worldPxPerSec`, then smoothed. `heightPx` is the lane height; a value of 1
 * reaches the top.
 */
export function skylineOutline(
  energy: Float32Array,
  binsPerSecond: number,
  worldPxPerSec: number,
  heightPx: number,
  smoothingSteps = 4,
): SkylineOutline {
  const points = new Float32Array(energy.length * 2);
  for (let bin = 0; bin < energy.length; bin += 1) {
    const value = Math.min(1, Math.max(0, energy[bin] ?? 0));
    points[bin * 2] = ((bin + 0.5) / binsPerSecond) * worldPxPerSec;
    points[bin * 2 + 1] = heightPx - value * heightPx;
  }
  return { top: catmullRom(points, smoothingSteps) };
}

/** The window of the song to keep geometry for: the viewport plus one screen on both sides. */
export interface CullWindow {
  readonly startSec: number;
  readonly endSec: number;
}

export function cullWindow(originSec: number, visibleSec: number, durationSec: number): CullWindow {
  return {
    startSec: Math.max(0, originSec - visibleSec),
    endSec: Math.min(durationSec, originSec + 2 * visibleSec),
  };
}

/** True while `[originSec, originSec + visibleSec]` is still inside the built window. */
export function windowCovers(
  built: CullWindow,
  originSec: number,
  visibleSec: number,
  durationSec: number,
): boolean {
  const need = {
    startSec: Math.max(0, originSec),
    endSec: Math.min(durationSec, originSec + visibleSec),
  };
  return built.startSec <= need.startSec + 1e-6 && built.endSec >= need.endSec - 1e-6;
}

/** A deterministic hash in [0, 1) so grain is stable between rebuilds. */
export function hash01(index: number): number {
  let h = Math.imul(index ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export interface StripInput {
  /** Thickness per bin, 0..1 (RMS). */
  readonly thickness: Float32Array;
  /** Brightness per bin, 0..1. Optional. */
  readonly brightness?: Float32Array | undefined;
  /** Noisiness per bin, 0..1. Optional. */
  readonly noisiness?: Float32Array | undefined;
  /** 1 where the stem is active, 0 where it fades to a thin line. */
  readonly active: Uint8Array;
  /** The first bin's absolute index, so grain stays put when the window slides. */
  readonly firstBin: number;
  readonly binsPerSecond: number;
  readonly worldPxPerSec: number;
  /** Half the lane's usable height in px. */
  readonly halfHeightPx: number;
  /** x offset (world px) of the first bin's left edge. */
  readonly offsetPx: number;
}

export interface RibbonStrip {
  /** Three vertices per bin: top, centre, bottom (x, y relative to the lane centre). */
  readonly positions: Float32Array;
  /** u = bin / bins, v = 0, 0.5, 1. */
  readonly uvs: Float32Array;
  readonly indices: Uint32Array;
  readonly bins: number;
}

/** The thinnest a ribbon gets where its stem is inactive, in px of half thickness. */
export const THIN_LINE_HALF_PX = 0.6;

/**
 * Builds the ribbon as a triangle strip (07 §9: "one vertex pair per envelope bin"; the centre
 * vertex is a third per bin so the texture can brighten the core). Vertex x is the bin centre.
 */
export function buildRibbonStrip(input: StripInput): RibbonStrip {
  const bins = input.thickness.length;
  const positions = new Float32Array(bins * 3 * 2);
  const uvs = new Float32Array(bins * 3 * 2);
  const binPx = input.worldPxPerSec / input.binsPerSecond;
  for (let bin = 0; bin < bins; bin += 1) {
    const x = input.offsetPx + (bin + 0.5) * binPx;
    const active = input.active[bin] === 1;
    let half = active
      ? Math.max(THIN_LINE_HALF_PX, (input.thickness[bin] ?? 0) * input.halfHeightPx)
      : THIN_LINE_HALF_PX;
    const noise = input.noisiness?.[bin] ?? 0;
    if (active && noise > 0) {
      // Grain: noisy stems get a rough edge, tonal ones a clean one (07 §2 "texture").
      half *= 1 + noise * 0.35 * (hash01(input.firstBin + bin) * 2 - 1);
      half = Math.min(half, input.halfHeightPx);
    }
    const u = (bin + 0.5) / bins;
    const base = bin * 6;
    positions[base] = x;
    positions[base + 1] = -half;
    positions[base + 2] = x;
    positions[base + 3] = 0;
    positions[base + 4] = x;
    positions[base + 5] = half;
    uvs[base] = u;
    uvs[base + 1] = 0;
    uvs[base + 2] = u;
    uvs[base + 3] = 0.5;
    uvs[base + 4] = u;
    uvs[base + 5] = 1;
  }
  const quads = Math.max(0, bins - 1);
  const indices = new Uint32Array(quads * 12);
  for (let bin = 0; bin < quads; bin += 1) {
    const a = bin * 3;
    const b = (bin + 1) * 3;
    const o = bin * 12;
    // top-centre quad, centre-bottom quad
    indices.set([a, b, a + 1, b, b + 1, a + 1, a + 1, b + 1, a + 2, b + 1, b + 2, a + 2], o);
  }
  return { positions, uvs, indices, bins };
}

/**
 * The colour texture for a strip: `bins` columns by 3 rows (top edge, core, bottom edge), RGBA8.
 * Brightness lifts the whole column towards white; the core is lighter than the edges; inactive
 * columns are faint.
 */
export function ribbonTexturePixels(
  rgb: readonly [number, number, number],
  input: Pick<StripInput, "brightness" | "active" | "thickness">,
): Uint8Array {
  const bins = input.thickness.length;
  const pixels = new Uint8Array(bins * 3 * 4);
  for (let bin = 0; bin < bins; bin += 1) {
    const active = input.active[bin] === 1;
    const lift = (input.brightness?.[bin] ?? 0.35) * 0.45;
    const alpha = active ? 255 : 110;
    for (let row = 0; row < 3; row += 1) {
      const core = row === 1 ? 0.28 : 0;
      const mix = Math.min(1, lift + core);
      const o = (row * bins + bin) * 4;
      pixels[o] = Math.round(rgb[0] + (255 - rgb[0]) * mix);
      pixels[o + 1] = Math.round(rgb[1] + (255 - rgb[1]) * mix);
      pixels[o + 2] = Math.round(rgb[2] + (255 - rgb[2]) * mix);
      pixels[o + 3] = row === 1 ? alpha : Math.round(alpha * 0.92);
    }
  }
  return pixels;
}

/** Per-bin activity from clip extents (seconds): 1 inside any clip. */
export function activityMask(
  clips: readonly { readonly startSec: number; readonly endSec: number }[],
  startSec: number,
  binsPerSecond: number,
  count: number,
): Uint8Array {
  const mask = new Uint8Array(count);
  const dt = 1 / binsPerSecond;
  for (const clip of clips) {
    const from = Math.max(0, Math.floor((clip.startSec - startSec) / dt));
    const to = Math.min(count - 1, Math.ceil((clip.endSec - startSec) / dt) - 1);
    for (let bin = from; bin <= to; bin += 1) mask[bin] = 1;
  }
  return mask;
}

/** Builds a min/max waveform strip (L3) from a peak window; same vertex layout as the ribbon. */
export function buildWaveformStrip(
  peaks: PeakWindow,
  binsPerSecond: number,
  worldPxPerSec: number,
  halfHeightPx: number,
  offsetPx: number,
): RibbonStrip {
  const bins = peaks.max.length;
  const positions = new Float32Array(bins * 3 * 2);
  const uvs = new Float32Array(bins * 3 * 2);
  const binPx = worldPxPerSec / binsPerSecond;
  for (let bin = 0; bin < bins; bin += 1) {
    const x = offsetPx + (bin + 0.5) * binPx;
    const top = -Math.max(THIN_LINE_HALF_PX, (peaks.max[bin] ?? 0) * halfHeightPx);
    const bottom = Math.max(THIN_LINE_HALF_PX, -(peaks.min[bin] ?? 0) * halfHeightPx);
    const u = (bin + 0.5) / bins;
    const base = bin * 6;
    positions.set([x, top, x, (top + bottom) / 2, x, bottom], base);
    uvs.set([u, 0, u, 0.5, u, 1], base);
  }
  const quads = Math.max(0, bins - 1);
  const indices = new Uint32Array(quads * 12);
  for (let bin = 0; bin < quads; bin += 1) {
    const a = bin * 3;
    const b = (bin + 1) * 3;
    indices.set([a, b, a + 1, b, b + 1, a + 1, a + 1, b + 1, a + 2, b + 1, b + 2, a + 2], bin * 12);
  }
  return { positions, uvs, indices, bins };
}

/**
 * Which beat/bar lines to draw (07 §2 beat grid): beats when they are at least `minBeatPx`
 * apart, otherwise every n-th bar so the lines never get denser than `minBarPx`.
 */
export interface GridLines {
  /** Indices into the beat list. */
  readonly indices: readonly number[];
  /** Bar-line flags, parallel to `indices`. */
  readonly isBar: readonly boolean[];
}

export function gridLines(
  beatTimesSec: ArrayLike<number>,
  beatsPerBar: number,
  fromSec: number,
  toSec: number,
  pxPerBeat: number,
  minBeatPx = 7,
  minBarPx = 10,
): GridLines {
  const indices: number[] = [];
  const isBar: boolean[] = [];
  const n = beatTimesSec.length;
  if (n === 0 || beatsPerBar < 1) return { indices, isBar };
  let first = 0;
  let high = n - 1;
  while (first < high) {
    const mid = (first + high) >> 1;
    if ((beatTimesSec[mid] ?? 0) < fromSec) first = mid + 1;
    else high = mid;
  }
  const drawBeats = pxPerBeat >= minBeatPx;
  let barStep = 1;
  while (pxPerBeat * beatsPerBar * barStep < minBarPx) barStep *= 2;
  for (let index = first; index < n; index += 1) {
    const time = beatTimesSec[index] ?? 0;
    if (time > toSec) break;
    const bar = index % beatsPerBar === 0;
    if (bar) {
      if ((index / beatsPerBar) % barStep === 0) {
        indices.push(index);
        isBar.push(true);
      }
    } else if (drawBeats) {
      indices.push(index);
      isBar.push(false);
    }
  }
  return { indices, isBar };
}

/** Shorthand used by the canvas: world px per second for a zoom and tempo. */
export function worldScale(pxPerBeat: number, bpm: number): number {
  return pxPerSecond(pxPerBeat, bpm);
}
