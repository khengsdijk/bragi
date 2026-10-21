/**
 * The offers after an edit (07 §4.8, §4.1): a cleared region → Fill gap, a smart-transition set →
 * Smooth with AI. They come from the batch that produced HEAD, so an undo or a new edit replaces
 * them without any timers.
 */
import type { OpBatch, Project } from "@bragi/schemas";
import { describe, expect, it } from "vitest";

import { buildDemoProject, fakeAssetHash, SHORT_DEMO } from "../../song/api/demo-song.js";
import { createGenerationOffers } from "../state/generation-offers.js";

const NOW = "2026-10-21T12:00:00.000Z";

function project(): Project {
  return buildDemoProject(SHORT_DEMO, {
    assetFor: (key) => fakeAssetHash(`offers:${key}`),
    projectId: "OFFERSTEST0000000000000001",
  }).project;
}

function batch(ops: OpBatch["ops"]): OpBatch {
  return { id: "bat_offers", author: { kind: "user" }, label: "Edit", ops, createdAt: NOW };
}

/** A single-track clear over bars 3–4, one Remove-brush stroke. */
function clear(track: string, startTick = 7_680, endTick = 15_360): OpBatch {
  return batch([{ op: "region.clear", region: { startTick, endTick, tracks: [track] } }]);
}

describe("generation offers", () => {
  it("offers Fill gap after a region was cleared", () => {
    const offers = createGenerationOffers();
    offers.consider(
      [
        batch([
          {
            op: "region.clear",
            region: { startTick: 7_680, endTick: 15_360, tracks: ["trk_drums", "trk_bass"] },
          },
        ]),
      ],
      project(),
    );
    const state = offers.store.getState();
    expect(state.fill?.region).toEqual({
      startTick: 7_680,
      endTick: 15_360,
      tracks: ["trk_drums", "trk_bass"],
    });
    expect(state.fill?.label).toContain("Drums and Bass");
    expect(state.fill?.label).toContain("bars 3–4");
    expect(state.smooth).toEqual([]);
  });

  it("offers Smooth with AI on the boundaries a move re-joined", () => {
    const doc = project();
    const offers = createGenerationOffers();
    offers.consider(
      [
        batch([
          { op: "section.move", sectionId: "sec_002", toIndex: 1 },
          {
            op: "section.set_transition",
            sectionId: "sec_002",
            transition: { kind: "crossfade", lengthTicks: 960 },
          },
        ]),
      ],
      doc,
    );
    expect(offers.store.getState().smooth).toEqual([
      { sectionId: "sec_002", boundaryTick: 23_040 },
    ]);
    expect(offers.store.getState().fill).toBeNull();
  });

  it("clears both offers for an unrelated commit and for no commit", () => {
    const offers = createGenerationOffers();
    offers.consider(
      [batch([{ op: "region.clear", region: { startTick: 0, endTick: 3_840, tracks: "all" } }])],
      project(),
    );
    expect(offers.store.getState().fill).not.toBeNull();
    offers.consider(
      [batch([{ op: "track.update", trackId: "trk_drums", patch: { gainDb: -1 } }])],
      project(),
    );
    expect(offers.store.getState()).toEqual({ fill: null, smooth: [] });
    offers.consider([], project());
    expect(offers.store.getState()).toEqual({ fill: null, smooth: [] });
  });

  it("merges two adjacent single-track erases into one offer", () => {
    const offers = createGenerationOffers();
    offers.consider([clear("trk_bass"), clear("trk_drums")], project());
    const fill = offers.store.getState().fill;
    expect(fill?.region).toEqual({
      startTick: 7_680,
      endTick: 15_360,
      tracks: ["trk_drums", "trk_bass"],
    });
    expect(fill?.label).toContain("Drums and Bass");
    expect(fill?.label).toContain("bars 3–4");
  });

  it("keeps only the latest erase when they cover different bars", () => {
    const offers = createGenerationOffers();
    offers.consider([clear("trk_bass", 7_680, 15_360), clear("trk_drums", 0, 3_840)], project());
    expect(offers.store.getState().fill?.region).toEqual({
      startTick: 7_680,
      endTick: 15_360,
      tracks: ["trk_bass"],
    });
  });

  it("keeps only the latest stroke when staggered erases overlap", () => {
    const offers = createGenerationOffers();
    // Bass over bars 11–14 at HEAD, drums over bars 9–12 just before it.
    offers.consider(
      [clear("trk_bass", 38_400, 53_760), clear("trk_drums", 30_720, 46_080)],
      project(),
    );
    expect(offers.store.getState().fill?.region).toEqual({
      startTick: 38_400,
      endTick: 53_760,
      tracks: ["trk_bass"],
    });
  });

  it("merges erases over the same bars with slightly different tick edges", () => {
    const offers = createGenerationOffers();
    // Both strokes snap inward to bars 3–4 even though one starts in bar 2 and ends in bar 5.
    offers.consider(
      [clear("trk_bass", 7_680, 15_360), clear("trk_drums", 7_600, 15_400)],
      project(),
    );
    const fill = offers.store.getState().fill;
    expect(fill?.region).toEqual({
      startTick: 7_680,
      endTick: 15_360,
      tracks: ["trk_drums", "trk_bass"],
    });
    expect(fill?.label).toContain("bars 3–4");
  });

  it("stops merging at a commit that is not a clear", () => {
    const offers = createGenerationOffers();
    offers.consider(
      [
        clear("trk_bass"),
        batch([{ op: "track.update", trackId: "trk_drums", patch: { gainDb: -1 } }]),
        clear("trk_drums"),
      ],
      project(),
    );
    expect(offers.store.getState().fill?.region).toEqual({
      startTick: 7_680,
      endTick: 15_360,
      tracks: ["trk_bass"],
    });
  });

  it("lets an all-tracks erase absorb the merged offer", () => {
    const offers = createGenerationOffers();
    offers.consider(
      [
        clear("trk_bass"),
        batch([
          { op: "region.clear", region: { startTick: 7_680, endTick: 15_360, tracks: "all" } },
        ]),
      ],
      project(),
    );
    const fill = offers.store.getState().fill;
    expect(fill?.region.tracks).toBe("all");
    expect(fill?.label).toContain("Drums");
    expect(fill?.label).toContain("Bass");
  });
});
