import { describe, expect, it } from "vitest";

import { STROKE_SNAP_TICKS, strokeRegion, strokeStrength } from "../stroke.js";
import type { Stroke } from "../types.js";

const point = (tick: number, trackId: string, pressure = 0.5): Stroke["points"][number] => ({
  tick,
  trackId,
  pressure,
});

describe("strokeRegion", () => {
  it("snaps outwards to sixteenth notes and keeps the touched order", () => {
    const region = strokeRegion({
      points: [point(100, "trk_a"), point(500, "trk_b"), point(900, "trk_a")],
    });
    expect(STROKE_SNAP_TICKS).toBe(240);
    expect(region).toEqual({ startTick: 0, endTick: 960, tracks: ["trk_a", "trk_b"] });
  });

  it("gives a single point a whole sixteenth and clamps at the song start", () => {
    expect(strokeRegion({ points: [point(-30, "trk_a")] })).toEqual({
      startTick: 0,
      endTick: 240,
      tracks: ["trk_a"],
    });
    expect(strokeRegion({ points: [point(250, "trk_a")] })).toEqual({
      startTick: 240,
      endTick: 480,
      tracks: ["trk_a"],
    });
  });

  it("has no region without points", () => {
    expect(strokeRegion({ points: [] })).toBeNull();
  });
});

describe("strokeStrength", () => {
  it("averages pen pressure", () => {
    expect(strokeStrength({ points: [point(0, "a", 0.2), point(10, "a", 0.8)] })).toBeCloseTo(
      0.5,
      10,
    );
  });

  it("uses the size slider for a mouse, which carries no pressure", () => {
    expect(
      strokeStrength({
        points: [point(0, "a", 0.9)],
        pointerType: "mouse",
        sizeStrength: 0.25,
      }),
    ).toBe(0.25);
    expect(strokeStrength({ points: [point(0, "a", 0.9)], pointerType: "mouse" })).toBe(0.5);
  });

  it("nudges the strength with the wheel in 0.1 steps, clamped to 0..1", () => {
    expect(strokeStrength({ points: [point(0, "a", 0.5)], wheelDelta: 2 })).toBeCloseTo(0.7, 10);
    expect(strokeStrength({ points: [point(0, "a", 0.5)], wheelDelta: -2 })).toBeCloseTo(0.3, 10);
    expect(strokeStrength({ points: [point(0, "a", 0.5)], wheelDelta: 9 })).toBe(1);
    expect(strokeStrength({ points: [point(0, "a", 0.5)], wheelDelta: -9 })).toBe(0);
  });

  it("is zero for an empty stroke", () => {
    expect(strokeStrength({ points: [] })).toBe(0);
  });
});
