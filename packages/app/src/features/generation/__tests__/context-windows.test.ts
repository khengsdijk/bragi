/**
 * Bar-aligned context windows (09 §4.3–4.4).
 *
 * The demo is 16 bars of 4/4 at 120 BPM, so a bar is 3 840 ticks and 2 s. A fill's `before` must end
 * on the gap's first bar line, `after` must start on its last, and neither side may run past the
 * 15 s (fill) or 8-bar (transition) budget. The windows are clamped to the song.
 */
import { describe, expect, it } from "vitest";

import {
  barLines,
  barsEndingAt,
  barsStartingAt,
  gapBars,
  rangeEndingAt,
  rangeStartingAt,
  samplesBetween,
  snapRegionToBars,
} from "../state/context-windows.js";
import { geometryFor } from "../state/session-geometry.js";
import { openSong, TICKS_PER_BAR } from "./generation-fixture.js";

async function geometry() {
  const song = await openSong();
  const value = geometryFor(song.songStore);
  if (value === null) throw new Error("no geometry");
  return { value, doc: song.songStore.store.getState().doc };
}

describe("bar-aligned context windows", () => {
  it("snaps an erased region inward to whole bars", async () => {
    const { doc } = await geometry();
    if (doc === null) throw new Error("no document");
    // A region that starts and ends mid-bar loses both partial bars.
    const snapped = snapRegionToBars(doc, {
      startTick: 2 * TICKS_PER_BAR + 100,
      endTick: 5 * TICKS_PER_BAR - 100,
    });
    expect(snapped).toEqual({ startTick: 3 * TICKS_PER_BAR, endTick: 4 * TICKS_PER_BAR });
    expect(gapBars(doc, snapped)).toBe(1);
    // Inside one bar the gap widens to that bar: the worker cannot generate less than one.
    expect(
      snapRegionToBars(doc, {
        startTick: 2 * TICKS_PER_BAR + 100,
        endTick: 2 * TICKS_PER_BAR + 200,
      }),
    ).toEqual({ startTick: 2 * TICKS_PER_BAR, endTick: 3 * TICKS_PER_BAR });
  });

  it("walks bar lines and clamps to the song", async () => {
    const { value, doc } = await geometry();
    if (doc === null) throw new Error("no document");
    expect(barLines(doc).slice(0, 3)).toEqual([0, TICKS_PER_BAR, 2 * TICKS_PER_BAR]);

    const before = rangeEndingAt(doc, value, 6 * TICKS_PER_BAR, 15);
    expect(before.endTick).toBe(6 * TICKS_PER_BAR);
    expect(before.startTick % TICKS_PER_BAR).toBe(0);
    // The demo is only 32 s, so 15 s is the whole first 7 bars.
    expect(before.endTick - before.startTick).toBe(6 * TICKS_PER_BAR);

    const after = rangeStartingAt(doc, value, 6 * TICKS_PER_BAR, 15);
    expect(after.startTick).toBe(6 * TICKS_PER_BAR);
    // Seven whole bars are 14 s; the eighth would be 16 s and is left out.
    expect(after.endTick).toBe(13 * TICKS_PER_BAR);

    expect(barsEndingAt(doc, 6 * TICKS_PER_BAR, 8)).toEqual({
      startTick: 0,
      endTick: 6 * TICKS_PER_BAR,
    });
    expect(barsStartingAt(doc, 6 * TICKS_PER_BAR, 8)).toEqual({
      startTick: 6 * TICKS_PER_BAR,
      endTick: 14 * TICKS_PER_BAR,
    });
    expect(samplesBetween(value, 0, TICKS_PER_BAR)).toBe(96_000);
  });
});
