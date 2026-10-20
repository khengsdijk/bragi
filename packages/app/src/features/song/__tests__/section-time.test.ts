import { describe, expect, it } from "vitest";

import { secondsAtTicks, sectionSpanSec, ticksAtSeconds } from "../api/section-time.js";
import { loadDemo } from "./fixtures.js";

describe("section time", () => {
  it("converts seconds and ticks through the model's tempo map", async () => {
    const { store } = await loadDemo();
    const handle = store.handle();
    if (handle === null) throw new Error("no handle");
    // The demo is 120 BPM at PPQ 960: a bar is two seconds and 3840 ticks.
    expect(ticksAtSeconds(store.model, handle, 2)).toBe(3840);
    expect(secondsAtTicks(store.model, handle, 3840)).toBe(2);
    expect(Math.round(ticksAtSeconds(store.model, handle, 5.25))).toBe(10_080);
  });

  it("gives a section's full span in both units", async () => {
    const { store, project } = await loadDemo();
    const handle = store.handle();
    if (handle === null) throw new Error("no handle");
    const span = sectionSpanSec(store.model, handle, project.arrangement.sections[1]?.id ?? "");
    expect(span).toMatchObject({ startTick: 7680, endTick: 23_040, startSec: 4, endSec: 12 });
  });
});
