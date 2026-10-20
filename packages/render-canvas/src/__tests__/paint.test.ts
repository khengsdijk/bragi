import { describe, expect, it } from "vitest";

import { beginPaintStroke, extendPaintStroke, nudgePaintStroke, paintSpan } from "../paint.js";

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
});
