import { describe, expect, it } from "vitest";

import {
  beginLasso,
  extendLasso,
  lassoHasRegion,
  lassoRegion,
  setLassoAlt,
} from "../lasso.js";

const point = (sec: number, trackId: string | null, y = 40) => ({ sec, trackId, y });

describe("the lasso shape", () => {
  it("bounds time and lists the ribbons in first-touch order", () => {
    const lasso = extendLasso(
      extendLasso(beginLasso(point(4, "trk_drums"), false), point(6, "trk_bass")),
      point(2, "trk_drums"),
    );
    expect(lasso.region).toEqual({
      startSec: 2,
      endSec: 6,
      trackIds: ["trk_drums", "trk_bass"],
    });
    expect(lasso.points).toHaveLength(3);
  });

  it("drops a point that repeats the last one", () => {
    const start = beginLasso(point(4, "trk_drums"), false);
    expect(extendLasso(start, point(4.005, "trk_drums")).points).toHaveLength(1);
    expect(extendLasso(start, point(4.2, "trk_drums")).points).toHaveLength(2);
  });

  it("keeps null points out of the track list", () => {
    const lasso = extendLasso(beginLasso(point(4, "trk_drums"), false), point(5, null));
    expect(lasso.region.trackIds).toEqual(["trk_drums"]);
  });

  it("records Alt for the app's snapping decision", () => {
    const start = beginLasso(point(4, "trk_drums"), false);
    expect(setLassoAlt(start, true).altKey).toBe(true);
    expect(setLassoAlt(start, false)).toBe(start);
  });

  it("is usable only with time and a ribbon", () => {
    expect(lassoRegion([])).toEqual({ startSec: 0, endSec: 0, trackIds: [] });
    expect(lassoHasRegion(lassoRegion([point(4, "trk_drums")]))).toBe(false);
    expect(lassoHasRegion(lassoRegion([point(4, "trk_drums"), point(5, "trk_drums")]))).toBe(
      true,
    );
    expect(lassoHasRegion(lassoRegion([point(4, null), point(5, null)]))).toBe(false);
  });
});
