import { describe, expect, it } from "vitest";

import { applyMixDelta } from "../engine/delta.js";

const doc = {
  id: "prj_a",
  tracks: [
    { id: "trk_a", name: "Drums", mute: false, solo: false },
    { id: "trk_b", name: "Bass", mute: false, solo: false },
  ],
};

const empty = {
  timebaseChanged: false,
  metaChanged: false,
  masterChanged: false,
  sourcesAdded: [],
  sourcesRemoved: [],
  tracksAdded: [],
  tracksRemoved: [],
  tracksUpdated: [],
  sectionsAdded: [],
  sectionsRemoved: [],
  sectionsUpdated: [],
  requiresFullResync: false,
};

describe("applyMixDelta", () => {
  it("swaps the updated tracks into the host's copy and leaves the rest alone", () => {
    const next = applyMixDelta(doc, {
      ...empty,
      tracksUpdated: [{ id: "trk_b", name: "Bass", mute: true, solo: false }],
    });
    expect(next).not.toBeNull();
    expect(next?.tracks).toEqual([
      { id: "trk_a", name: "Drums", mute: false, solo: false },
      { id: "trk_b", name: "Bass", mute: true, solo: false },
    ]);
    // The input is not mutated.
    expect(doc.tracks[1]?.mute).toBe(false);
  });

  it("returns the same document for an empty delta", () => {
    expect(applyMixDelta(doc, empty)).toBe(doc);
  });

  it("refuses structural changes so the caller reloads the document", () => {
    expect(applyMixDelta(doc, { ...empty, requiresFullResync: true })).toBeNull();
    expect(applyMixDelta(doc, { ...empty, tracksAdded: [{ id: "trk_c" }] })).toBeNull();
    expect(applyMixDelta(doc, { ...empty, sectionsUpdated: [{ id: "sec_a" }] })).toBeNull();
    expect(applyMixDelta(doc, { ...empty, timebaseChanged: true })).toBeNull();
    expect(applyMixDelta(doc, { ...empty, masterChanged: true })).toBeNull();
  });
});
