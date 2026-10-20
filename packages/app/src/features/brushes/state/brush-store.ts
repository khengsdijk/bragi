/**
 * The paint tool's UI state (07 §4.4, 11 §6.2): which tool is active, which brush is chosen, the
 * brush-size strength and the filter sweep's direction.
 *
 * This is ephemeral editing state, not a song setting: it is not persisted, so a reload starts
 * with Select and Space at 0.5, the same neutral state as a fresh canvas. The document only
 * changes when a stroke commits one batch through the song/history stores.
 */
import type { CanvasTool } from "@bragi/render-canvas";
import { createStore, type StoreApi } from "zustand/vanilla";

import type { BrushId, FilterDirection } from "../types.js";

export interface BrushState {
  readonly tool: CanvasTool;
  readonly brush: BrushId;
  /** 0..1, the brush-size slider and a mouse stroke's opacity. */
  readonly sizeStrength: number;
  readonly direction: FilterDirection;
}

export interface BrushStore {
  readonly store: StoreApi<BrushState>;
  setTool(tool: CanvasTool): void;
  /** `B`: Paint on or off, back to Select. */
  togglePaint(): void;
  setBrush(brush: BrushId): void;
  setSizeStrength(strength: number): void;
  setDirection(direction: FilterDirection): void;
}

/** The neutral state: Select, Space, half strength, a rising sweep. */
export const DEFAULT_BRUSH_STATE: BrushState = {
  tool: "select",
  brush: "space",
  sizeStrength: 0.5,
  direction: "up",
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function createBrushStore(initial: Partial<BrushState> = {}): BrushStore {
  const store = createStore<BrushState>(() => ({ ...DEFAULT_BRUSH_STATE, ...initial }));
  return {
    store,
    setTool: (tool) => store.setState({ tool }),
    togglePaint: () =>
      store.setState((state) => ({ tool: state.tool === "paint" ? "select" : "paint" })),
    setBrush: (brush) => store.setState({ brush }),
    setSizeStrength: (sizeStrength) => store.setState({ sizeStrength: clamp01(sizeStrength) }),
    setDirection: (direction) => store.setState({ direction }),
  };
}
