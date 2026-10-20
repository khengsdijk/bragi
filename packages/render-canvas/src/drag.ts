/**
 * Section drags (07 §4.1–4.2, 11 §6.4): the threshold that separates a click from a drag, the
 * insertion slot under the pointer and the bar snapping of the right-edge resize.
 *
 * Everything here is pure. {@link SongCanvas} keeps one {@link SectionDragState} and turns its
 * transitions into the `sectionDrag*` / `sectionResize*` events the app receives.
 */

/** Movement below this is a click (selection), not a drag (11 §6.4). */
export const DRAG_THRESHOLD_PX = 4;

/** Invisible handle centred on a block's right edge (11 §6.4: "section edges have ... 12 px"). */
export const SECTION_EDGE_HANDLE_PX = 12;

/** A section never shrinks below one bar and the editor caps its length at 64 (task B's dialog). */
export const MAX_SECTION_BARS = 64;

/** What a section drag does: move the block or resize it from the right edge. */
export type DragMode = "move" | "resize";

export interface IdleDrag {
  readonly phase: "idle";
}

export interface PendingDrag {
  readonly phase: "pending";
  readonly sectionId: string;
  readonly mode: DragMode;
  readonly startX: number;
  readonly startY: number;
  readonly altKey: boolean;
}

export interface ActiveDrag {
  readonly phase: "dragging";
  readonly sectionId: string;
  readonly mode: DragMode;
  readonly startX: number;
  readonly startY: number;
  /** Pointer x in canvas coordinates (relative to the canvas element). */
  readonly pointerX: number;
  readonly altKey: boolean;
}

export type SectionDragState = IdleDrag | PendingDrag | ActiveDrag;

export const IDLE_DRAG: IdleDrag = { phase: "idle" };

/** Starts a gesture as a click; it becomes a drag once the pointer passes the threshold. */
export function beginSectionDrag(
  sectionId: string,
  mode: DragMode,
  x: number,
  y: number,
  altKey: boolean,
): PendingDrag {
  return { phase: "pending", sectionId, mode, startX: x, startY: y, altKey };
}

/** Advances the state machine. Returning to the start does not make an active drag pending again. */
export function advanceSectionDrag(
  state: SectionDragState,
  x: number,
  y: number,
  altKey: boolean,
): SectionDragState {
  if (state.phase === "idle") return state;
  if (state.phase === "dragging") {
    return state.pointerX === x && state.altKey === altKey
      ? state
      : { ...state, pointerX: x, altKey };
  }
  const dx = Math.abs(x - state.startX);
  const dy = Math.abs(y - state.startY);
  if (Math.max(dx, dy) < DRAG_THRESHOLD_PX) return state;
  return {
    phase: "dragging",
    sectionId: state.sectionId,
    mode: state.mode,
    startX: state.startX,
    startY: state.startY,
    pointerX: x,
    altKey,
  };
}

/**
 * The insertion slot nearest the pointer in the document as it was before the drag: the number of
 * section centres left of the pointer, 0..sections.length. The app maps it onto `section.move`
 * (which removes the dragged block first) or `section.duplicate` (which inserts straight away).
 */
export function dropSlotAt(
  sections: readonly { readonly startSec: number; readonly endSec: number }[],
  sec: number,
): number {
  let slot = 0;
  for (const section of sections) {
    if ((section.startSec + section.endSec) / 2 < sec) slot += 1;
  }
  return slot;
}

/**
 * The target length of a right-edge drag in whole bars: the start length plus the snapped pixel
 * delta, clamped to 1..64 bars. `barPx` is one bar on the time axis.
 */
export function resizeTargetBars(startBars: number, deltaPx: number, barPx: number): number {
  if (!Number.isFinite(barPx) || barPx <= 0) return startBars;
  const deltaBars = Math.round(deltaPx / barPx);
  return Math.max(1, Math.min(MAX_SECTION_BARS, startBars + deltaBars));
}

/** "+8 bars" / "−2 bars", in the app's language (11 §2). */
export function barDeltaLabel(
  targetBars: number,
  startBars: number,
  longer: (bars: number) => string,
  shorter: (bars: number) => string,
): string {
  const delta = targetBars - startBars;
  if (delta === 0) return "";
  return delta > 0 ? longer(delta) : shorter(-delta);
}
