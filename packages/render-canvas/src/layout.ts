/**
 * Where everything sits (07 §1): the lanes stacked in the order of the layout diagram, all
 * sharing one horizontal time axis, with a label gutter on the left that holds each ribbon's
 * name and its solo/mute buttons. Pure functions, so hit testing is unit-tested without a GPU.
 */
import { SECTION_EDGE_HANDLE_PX } from "./drag.js";
import type { CanvasDocument, Viewport, ZoomLevel } from "./types.js";
import { pxPerSecond, xToTime } from "./viewport.js";

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Lane heights in CSS px at 100 % text size (07 §2: skyline 48 px, harmony 20 px). */
export const BASE = {
  gutter: 148,
  ruler: 22,
  skyline: 48,
  skylinePad: 6,
  sections: 36,
  sectionsPad: 6,
  harmony: 20,
  harmonyPad: 8,
  ribbon: 40,
  ribbonMoment: 72,
  ribbonPad: 4,
  /** Hit targets are at least 24 x 24 (11 §6.4). */
  button: 24,
} as const;

export interface RibbonLane {
  readonly trackId: string;
  readonly rect: Rect;
  readonly mute: Rect;
  readonly solo: Rect;
}

export interface Layout {
  readonly width: number;
  readonly height: number;
  /** The left edge of the time area; `width - gutter` is its width. */
  readonly gutter: number;
  readonly ruler: Rect;
  readonly skyline: Rect;
  readonly sections: Rect;
  readonly harmony: Rect;
  readonly ribbons: readonly RibbonLane[];
}

export interface LayoutOptions {
  readonly width: number;
  /** Visible ribbons, top to bottom. */
  readonly trackIds: readonly string[];
  readonly level: ZoomLevel;
  /** Text scale, 1 at 100 %. Lanes grow with it (11 §6.4). */
  readonly uiScale: number;
}

/** Computes the lane rectangles. */
export function computeLayout(options: LayoutOptions): Layout {
  const { width, level, uiScale } = options;
  const scale = Math.max(1, uiScale);
  const gutter = Math.round(BASE.gutter * scale);
  const timeX = gutter;
  const timeW = Math.max(0, width - gutter);
  let y = 0;
  const ruler: Rect = { x: timeX, y, w: timeW, h: Math.round(BASE.ruler * scale) };
  y += ruler.h;
  const skyline: Rect = { x: timeX, y, w: timeW, h: Math.round(BASE.skyline * scale) };
  y += skyline.h + BASE.skylinePad;
  const sections: Rect = { x: timeX, y, w: timeW, h: Math.round(BASE.sections * scale) };
  y += sections.h + BASE.sectionsPad;
  const harmony: Rect = { x: timeX, y, w: timeW, h: Math.round(BASE.harmony * scale) };
  y += harmony.h + BASE.harmonyPad;

  const laneH = Math.round((level === "L3" ? BASE.ribbonMoment : BASE.ribbon) * scale);
  const button = Math.round(BASE.button * Math.min(scale, 1.5));
  const ribbons: RibbonLane[] = [];
  for (const trackId of options.trackIds) {
    const rect: Rect = { x: 0, y, w: width, h: laneH };
    const by = y + Math.round((laneH - button) / 2);
    ribbons.push({
      trackId,
      rect,
      solo: { x: gutter - button - 6, y: by, w: button, h: button },
      mute: { x: gutter - 2 * button - 10, y: by, w: button, h: button },
    });
    y += laneH + BASE.ribbonPad;
  }
  return { width, height: y + BASE.ribbonPad, gutter, ruler, skyline, sections, harmony, ribbons };
}

export function contains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
}

/** A ribbon point: the track under the pointer and its arrangement time. */
export interface RibbonPoint {
  readonly trackId: string;
  /** Arrangement time in seconds. */
  readonly sec: number;
}

/**
 * The ribbon under a point in the time area, or `null` (07 §4.4). The gutter is not a ribbon:
 * painting never starts on the solo/mute buttons or the track names.
 */
export function ribbonAt(
  layout: Layout,
  viewport: Viewport,
  doc: CanvasDocument,
  x: number,
  y: number,
): RibbonPoint | null {
  if (x < layout.gutter) return null;
  for (const lane of layout.ribbons) {
    if (contains(lane.rect, x, y)) {
      return {
        trackId: lane.trackId,
        sec: xToTime(viewport, doc.bpm, x - layout.gutter),
      };
    }
  }
  return null;
}

/**
 * Where a paint sample lands: the ribbon under the pointer, or the nearest ribbon row the stroke
 * already touched when the pointer strays above or below the lanes. It never invents a track id,
 * and `null` before the first ribbon is touched.
 */
export function paintPointAt(
  layout: Layout,
  viewport: Viewport,
  doc: CanvasDocument,
  touchedTracks: ReadonlySet<string>,
  x: number,
  y: number,
): RibbonPoint | null {
  const direct = ribbonAt(layout, viewport, doc, x, y);
  if (direct !== null) return direct;
  if (touchedTracks.size === 0) return null;

  let nearest: RibbonLane | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const lane of layout.ribbons) {
    if (!touchedTracks.has(lane.trackId)) continue;
    const centre = lane.rect.y + lane.rect.h / 2;
    const next = Math.abs(y - centre);
    if (next < distance) {
      distance = next;
      nearest = lane;
    }
  }
  if (nearest === null) return null;
  const sec = xToTime(viewport, doc.bpm, Math.max(0, x - layout.gutter));
  return {
    trackId: nearest.trackId,
    sec: Math.min(doc.durationSec, Math.max(0, sec)),
  };
}

/** What is under a point. */
export type Hit =
  | { readonly kind: "ruler"; readonly sec: number }
  | { readonly kind: "skyline" }
  | { readonly kind: "section"; readonly id: string; readonly sec: number }
  | { readonly kind: "harmony" }
  | { readonly kind: "toggle"; readonly trackId: string; readonly field: "mute" | "solo" }
  | { readonly kind: "ribbon"; readonly trackId: string; readonly sec: number | null }
  | { readonly kind: "none" };

/** The section containing `sec`, by binary search over the ordered sections. */
export function sectionAt(doc: CanvasDocument, sec: number): string | null {
  const sections = doc.sections;
  let low = 0;
  let high = sections.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const section = sections[mid];
    if (!section) return null;
    if (sec < section.startSec) high = mid - 1;
    else if (sec >= section.endSec) low = mid + 1;
    else return section.id;
  }
  return null;
}

/** Resolves a pointer position to the thing under it. Toggles win over their ribbon. */
export function hitTest(
  layout: Layout,
  viewport: Viewport,
  doc: CanvasDocument,
  x: number,
  y: number,
): Hit {
  for (const lane of layout.ribbons) {
    if (contains(lane.mute, x, y)) return { kind: "toggle", trackId: lane.trackId, field: "mute" };
    if (contains(lane.solo, x, y)) return { kind: "toggle", trackId: lane.trackId, field: "solo" };
  }
  const sec = xToTime(viewport, doc.bpm, x - layout.gutter);
  if (contains(layout.ruler, x, y)) return { kind: "ruler", sec };
  if (contains(layout.skyline, x, y)) return { kind: "skyline" };
  if (contains(layout.sections, x, y)) {
    const id = sectionAt(doc, sec);
    return id === null ? { kind: "none" } : { kind: "section", id, sec };
  }
  if (contains(layout.harmony, x, y)) return { kind: "harmony" };
  for (const lane of layout.ribbons) {
    if (contains(lane.rect, x, y)) {
      return { kind: "ribbon", trackId: lane.trackId, sec: x >= layout.gutter ? sec : null };
    }
  }
  return { kind: "none" };
}

/** A pointer target in the section lane: the block body or its enlarged right-edge handle. */
export interface SectionHit {
  readonly kind: "body" | "rightEdge";
  readonly sectionId: string;
}

/**
 * What a pointer on the section lane grabs (07 §4.1–4.2): the body (move) or the right edge
 * (resize). The edge wins over the body and is a 12 px handle centred on the boundary, so its
 * right half reaches into the next block (11 §6.4).
 */
export function sectionHitAt(
  layout: Layout,
  viewport: Viewport,
  doc: CanvasDocument,
  x: number,
  y: number,
): SectionHit | null {
  if (!contains(layout.sections, x, y) || x < layout.gutter) return null;
  const pps = pxPerSecond(viewport.pxPerBeat, doc.bpm);
  const toX = (sec: number): number => layout.gutter + (sec - viewport.originSec) * pps;
  for (const section of doc.sections) {
    if (Math.abs(x - toX(section.endSec)) <= SECTION_EDGE_HANDLE_PX / 2) {
      return { kind: "rightEdge", sectionId: section.id };
    }
  }
  const id = sectionAt(doc, xToTime(viewport, doc.bpm, x - layout.gutter));
  return id === null ? null : { kind: "body", sectionId: id };
}

/** The section under a canvas point, or `null` (the context-menu hit test). */
export function sectionAtPoint(
  layout: Layout,
  viewport: Viewport,
  doc: CanvasDocument,
  x: number,
  y: number,
): string | null {
  const hit = hitTest(layout, viewport, doc, x, y);
  return hit.kind === "section" ? hit.id : null;
}
