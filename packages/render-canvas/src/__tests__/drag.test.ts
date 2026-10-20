import { describe, expect, it } from "vitest";

import {
  advanceSectionDrag,
  barDeltaLabel,
  beginSectionDrag,
  DRAG_THRESHOLD_PX,
  dropSlotAt,
  IDLE_DRAG,
  resizeTargetBars,
  SECTION_EDGE_HANDLE_PX,
} from "../drag.js";
import { computeLayout, sectionHitAt } from "../layout.js";
import type { CanvasDocument } from "../types.js";
import { pxPerSecond } from "../viewport.js";

function doc(): CanvasDocument {
  return {
    id: "prj_a",
    title: "T",
    durationSec: 60,
    bpm: 120,
    beatsPerBar: 4,
    beatTimesSec: Array.from({ length: 120 }, (_, i) => i * 0.5),
    sections: [
      {
        id: "sec_a",
        kind: "intro",
        label: "Intro",
        startSec: 0,
        endSec: 20,
        bars: 10,
        locked: false,
      },
      {
        id: "sec_b",
        kind: "verse",
        label: "Verse",
        startSec: 20,
        endSec: 60,
        bars: 20,
        locked: false,
      },
    ],
    tracks: [],
    clips: [],
  };
}

const layout = computeLayout({ width: 1000, trackIds: [], level: "L2", uiScale: 1 });
const viewport = { pxPerBeat: 8, originSec: 0 };
const y = layout.sections.y + 8;
const xAt = (sec: number): number => layout.gutter + sec * pxPerSecond(8, 120);

describe("section hit testing (07 §4.1–4.2, 11 §6.4)", () => {
  const song = doc();

  it("grabs the body of the block", () => {
    expect(sectionHitAt(layout, viewport, song, xAt(10), y)).toEqual({
      kind: "body",
      sectionId: "sec_a",
    });
    expect(sectionHitAt(layout, viewport, song, xAt(30), y)).toEqual({
      kind: "body",
      sectionId: "sec_b",
    });
  });

  it("grabs a 12 px handle centred on the right edge", () => {
    const edge = xAt(20);
    const reach = SECTION_EDGE_HANDLE_PX / 2;
    expect(SECTION_EDGE_HANDLE_PX).toBe(12);
    expect(sectionHitAt(layout, viewport, song, edge - reach + 0.1, y)).toEqual({
      kind: "rightEdge",
      sectionId: "sec_a",
    });
    expect(sectionHitAt(layout, viewport, song, edge + reach - 0.1, y)).toEqual({
      kind: "rightEdge",
      sectionId: "sec_a",
    });
    // Just outside the handle it is body again.
    expect(sectionHitAt(layout, viewport, song, edge - reach - 1, y)).toEqual({
      kind: "body",
      sectionId: "sec_a",
    });
    expect(sectionHitAt(layout, viewport, song, edge + reach + 1, y)).toEqual({
      kind: "body",
      sectionId: "sec_b",
    });
  });

  it("ignores the gutter and the other lanes", () => {
    expect(sectionHitAt(layout, viewport, song, layout.gutter - 4, y)).toBeNull();
    expect(sectionHitAt(layout, viewport, song, xAt(10), layout.ruler.y + 2)).toBeNull();
    expect(sectionHitAt(layout, viewport, song, xAt(70), y)).toBeNull();
  });
});

describe("drag threshold state machine (11 §6.4)", () => {
  it("stays a click below 4 px and becomes a drag at the threshold", () => {
    const pending = beginSectionDrag("sec_a", "move", 100, 100, false);
    expect(pending.phase).toBe("pending");
    expect(advanceSectionDrag(pending, 100 + DRAG_THRESHOLD_PX - 1, 100, false).phase).toBe(
      "pending",
    );
    const active = advanceSectionDrag(pending, 100 + DRAG_THRESHOLD_PX, 100, false);
    expect(active).toMatchObject({ phase: "dragging", pointerX: 104, altKey: false });
  });

  it("counts vertical movement and remembers Alt", () => {
    const pending = beginSectionDrag("sec_a", "resize", 100, 100, true);
    const active = advanceSectionDrag(pending, 100, 104, true);
    expect(active).toMatchObject({ phase: "dragging", altKey: true });
  });

  it("never falls back to pending once the drag started", () => {
    const active = advanceSectionDrag(
      beginSectionDrag("sec_a", "move", 100, 100, false),
      120,
      100,
      false,
    );
    expect(advanceSectionDrag(active, 101, 100, false)).toMatchObject({
      phase: "dragging",
      pointerX: 101,
    });
    expect(advanceSectionDrag(IDLE_DRAG, 500, 500, false)).toBe(IDLE_DRAG);
  });
});

describe("drop slots (07 §4.1)", () => {
  const sections = [
    { startSec: 0, endSec: 20 },
    { startSec: 20, endSec: 60 },
  ];

  it("counts the section centres left of the pointer, 0..n", () => {
    expect(dropSlotAt(sections, 0)).toBe(0);
    expect(dropSlotAt(sections, 5)).toBe(0);
    // The centre itself is a tie and stays before that block; just past it is the next slot.
    expect(dropSlotAt(sections, 10)).toBe(0);
    expect(dropSlotAt(sections, 10.1)).toBe(1);
    expect(dropSlotAt(sections, 39.9)).toBe(1);
    expect(dropSlotAt(sections, 40)).toBe(1);
    expect(dropSlotAt(sections, 40.1)).toBe(2);
    expect(dropSlotAt(sections, 60)).toBe(2);
    expect(dropSlotAt([], 10)).toBe(0);
  });
});

describe("resize ghost (07 §4.2)", () => {
  it("snaps the bar count to whole bars", () => {
    expect(resizeTargetBars(4, 2.4 * 50, 50)).toBe(6);
    expect(resizeTargetBars(4, 0.4 * 50, 50)).toBe(4);
    expect(resizeTargetBars(4, -0.6 * 50, 50)).toBe(3);
    expect(resizeTargetBars(4, 10, 0)).toBe(4);
  });

  it("clamps to one bar and to 64 bars", () => {
    expect(resizeTargetBars(4, -20 * 50, 50)).toBe(1);
    expect(resizeTargetBars(4, 100 * 50, 50)).toBe(64);
  });

  it("labels the delta in the app's words", () => {
    const longer = (bars: number) => `+${bars} bars`;
    const shorter = (bars: number) => `−${bars} bars`;
    expect(barDeltaLabel(6, 4, longer, shorter)).toBe("+2 bars");
    expect(barDeltaLabel(2, 4, longer, shorter)).toBe("−2 bars");
    expect(barDeltaLabel(4, 4, longer, shorter)).toBe("");
  });
});
