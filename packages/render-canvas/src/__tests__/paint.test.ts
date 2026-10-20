import { describe, expect, it } from "vitest";

import {
  beginPaintStroke,
  extendPaintStroke,
  MIN_PAINT_OPACITY,
  nudgePaintStroke,
  paintOpacity,
  paintSpan,
  wheelNotches,
} from "../paint.js";

describe("paint strokes", () => {
  it("collects points across ribbons and spans their time range", () => {
    let stroke = beginPaintStroke({ sec: 4, trackId: "trk_drums", pressure: 0.3 }, "pen");
    stroke = extendPaintStroke(stroke, { sec: 5, trackId: "trk_drums", pressure: 0.6 });
    stroke = extendPaintStroke(stroke, { sec: 3.5, trackId: "trk_bass", pressure: 0.9 });
    const span = paintSpan(stroke);
    expect(span.startSec).toBe(3.5);
    expect(span.endSec).toBe(5);
    expect([...span.tracks]).toEqual(["trk_drums", "trk_bass"]);
    expect(stroke.pointerType).toBe("pen");
  });

  it("does not grow while the pen rests, but follows its pressure", () => {
    const start = beginPaintStroke({ sec: 4, trackId: "trk_drums", pressure: 0.3 }, "pen");
    const same = extendPaintStroke(start, { sec: 4.005, trackId: "trk_drums", pressure: 0.3 });
    expect(same).toBe(start);
    const pressed = extendPaintStroke(start, { sec: 4.005, trackId: "trk_drums", pressure: 0.8 });
    expect(pressed.points).toHaveLength(1);
    expect(pressed.points[0]?.pressure).toBe(0.8);
  });

  it("accumulates wheel notches", () => {
    const start = beginPaintStroke({ sec: 1, trackId: "trk_a", pressure: 0.5 }, "mouse");
    expect(nudgePaintStroke(nudgePaintStroke(start, 1), 2).wheelDelta).toBe(3);
    expect(nudgePaintStroke(start, 0)).toBe(start);
  });

  it("draws a mouse at the size slider and a pen at its mean pressure", () => {
    const mouse = beginPaintStroke({ sec: 1, trackId: "trk_a", pressure: 0.5 }, "mouse");
    expect(paintOpacity(mouse, 0.8)).toBeCloseTo(0.8, 9);
    expect(paintOpacity(mouse, 0)).toBe(MIN_PAINT_OPACITY);

    let pen = beginPaintStroke({ sec: 1, trackId: "trk_a", pressure: 0.2 }, "pen");
    pen = extendPaintStroke(pen, { sec: 1.5, trackId: "trk_a", pressure: 0.8 });
    expect(paintOpacity(pen, 0.1)).toBeCloseTo(0.5, 9);
  });

  it("nudges the opacity by 0.1 per wheel notch and stops at 0.15 and 1", () => {
    const mouse = beginPaintStroke({ sec: 1, trackId: "trk_a", pressure: 0.5 }, "mouse");
    expect(paintOpacity(nudgePaintStroke(mouse, 2), 0.5)).toBeCloseTo(0.7, 9);
    expect(paintOpacity(nudgePaintStroke(mouse, -8), 0.5)).toBe(MIN_PAINT_OPACITY);
    expect(paintOpacity(nudgePaintStroke(mouse, 8), 0.5)).toBe(1);
  });

  it("turns wheel deltas into notches: up is positive", () => {
    expect(wheelNotches(-100, 0)).toBe(1);
    expect(wheelNotches(100, 0)).toBe(-1);
    expect(wheelNotches(-3, 1)).toBe(1);
    expect(wheelNotches(0, 0)).toBe(0);
    // A fast flick is capped so one event cannot hide the stroke.
    expect(wheelNotches(-10_000, 0)).toBe(3);
  });
});
