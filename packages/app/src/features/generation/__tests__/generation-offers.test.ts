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

describe("generation offers", () => {
  it("offers Fill gap after a region was cleared", () => {
    const offers = createGenerationOffers();
    offers.consider(
      batch([
        {
          op: "region.clear",
          region: { startTick: 7_680, endTick: 15_360, tracks: ["trk_drums", "trk_bass"] },
        },
      ]),
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
      batch([
        { op: "section.move", sectionId: "sec_002", toIndex: 1 },
        {
          op: "section.set_transition",
          sectionId: "sec_002",
          transition: { kind: "crossfade", lengthTicks: 960 },
        },
      ]),
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
      batch([{ op: "region.clear", region: { startTick: 0, endTick: 3_840, tracks: "all" } }]),
      project(),
    );
    expect(offers.store.getState().fill).not.toBeNull();
    offers.consider(
      batch([{ op: "track.update", trackId: "trk_drums", patch: { gainDb: -1 } }]),
      project(),
    );
    expect(offers.store.getState()).toEqual({ fill: null, smooth: [] });
    offers.consider(null, project());
    expect(offers.store.getState()).toEqual({ fill: null, smooth: [] });
  });
});
