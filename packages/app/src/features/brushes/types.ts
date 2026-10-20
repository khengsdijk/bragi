/**
 * The paint-brush vocabulary (07 §4.4, WP-2.4).
 *
 * A stroke is what the canvas reports while the pointer is down: the points it passed over (time,
 * ribbon, pen pressure), plus the wheel and size-slider input. Turning it into a region, a
 * strength and finally one op batch is pure document maths in `stroke.ts` and `batches.ts`; the
 * painting UI in task B only draws and reports.
 */
import type { Region } from "@bragi/schemas";

/** The instant brushes (07 §4.4). The ✨ brushes are jobs and arrive with WP-2.7. */
export type BrushId =
  | "space"
  | "warmth"
  | "brighter"
  | "darker"
  | "lofi"
  | "louder"
  | "quieter"
  | "filterSweep"
  | "remove";

/** Every instant brush, in the palette's order (07 §4.4). */
export const BRUSH_IDS = [
  "space",
  "warmth",
  "brighter",
  "darker",
  "lofi",
  "louder",
  "quieter",
  "filterSweep",
  "remove",
] as const satisfies readonly BrushId[];

/** The filter sweep's travel across the stroke, high to low or low to high. */
export type FilterDirection = "up" | "down";

/** The pointer type a stroke came from: a pen carries pressure, a mouse carries none. */
export type PointerType = "mouse" | "pen" | "touch";

/** One point the pointer passed over while painting. */
export interface StrokePoint {
  /** Absolute arrangement tick. */
  readonly tick: number;
  readonly trackId: string;
  /** Pointer pressure in `0..1`; a mouse reports `0.5`. */
  readonly pressure: number;
}

/** One brush stroke, as the canvas reports it on pointer up. */
export interface Stroke {
  readonly points: readonly StrokePoint[];
  /** Wheel notches accumulated while painting; positive is up. Each notch is one 0.1 step. */
  readonly wheelDelta?: number;
  /** The brush-size slider, used when the pointer has no pressure (a mouse). */
  readonly sizeStrength?: number;
  /** Which pointer produced the stroke; defaults to a pen. */
  readonly pointerType?: PointerType;
}

/** What the brush needs besides the stroke: the region it covers, its strength and direction. */
export interface BrushParams {
  readonly region: Region;
  /** `0..1`; the stroke's opacity in the canvas and the depth of the effect. */
  readonly strength: number;
  /** Filter sweep only; defaults to {@link FilterDirection} `"up"`. */
  readonly direction?: FilterDirection;
}
