import { describe, expect, it } from "vitest";

import { lassoSpanBars, snapLassoRegion } from "../snap.js";

/** 120 BPM, 4/4, PPQ 960: one beat is 0.5 s and one bar 2 s. */
const conversion = {
  bpm: 120,
  beatsPerBar: 4,
  ppq: 960,
  totalTicks: 76_800,
  ticksAtSeconds: (sec: number) => Math.round(sec * 1920),
  secondsAtTicks: (tick: number) => tick / 1920,
};

describe("lasso snapping", () => {
  it("snaps a short shape to beats", () => {
    const snapped = snapLassoRegion({
      ...conversion,
      startSec: 1.1,
      endSec: 3.2,
      trackIds: ["trk_drums", "trk_bass", "trk_drums"],
      altKey: false,
    });
    expect(snapped.region).toEqual({
      startTick: 1920,
      endTick: 5760,
      tracks: ["trk_drums", "trk_bass"],
    });
    expect(snapped.startSec).toBe(1);
    expect(snapped.endSec).toBe(3);
  });

  it("snaps to bars when the shape spans more than two bars", () => {
    expect(lassoSpanBars({ ...conversion, startSec: 0.1, endSec: 9.9 })).toBeGreaterThan(2);
    const snapped = snapLassoRegion({
      ...conversion,
      startSec: 0.1,
      endSec: 9.9,
      trackIds: ["trk_drums"],
      altKey: false,
    });
    expect(snapped.region.startTick).toBe(0);
    expect(snapped.region.endTick).toBe(19_200);
  });

  it("keeps the tick link with Alt", () => {
    const snapped = snapLassoRegion({
      ...conversion,
      startSec: 1.1,
      endSec: 3.2,
      trackIds: ["trk_drums"],
      altKey: true,
    });
    expect(snapped.region).toEqual({
      startTick: 2112,
      endTick: 6144,
      tracks: ["trk_drums"],
    });
  });

  it("grows a collapsed region and stays inside the song", () => {
    const snapped = snapLassoRegion({
      ...conversion,
      startSec: 1.001,
      endSec: 1.002,
      trackIds: ["trk_drums"],
      altKey: false,
    });
    expect(snapped.region.endTick).toBeGreaterThan(snapped.region.startTick);
    const atEnd = snapLassoRegion({
      ...conversion,
      startSec: 39.99,
      endSec: 40,
      trackIds: ["trk_drums"],
      altKey: false,
    });
    expect(atEnd.region.endTick).toBeLessThanOrEqual(conversion.totalTicks);
    expect(atEnd.region.startTick).toBeLessThan(atEnd.region.endTick);
  });
});
