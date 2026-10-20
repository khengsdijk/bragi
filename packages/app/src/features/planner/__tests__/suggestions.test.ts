import { describe, expect, it } from "vitest";

import { suggestionChips } from "../suggestions.js";

describe("prompt bar chips", () => {
  it("uses a drum vocabulary for one drum instrument", () => {
    expect(
      suggestionChips({ roles: ["drums"], trackCount: 1, sectionCount: 1, wholeSong: false }),
    ).toEqual([
      "planner.chip.halfTime",
      "planner.chip.moreLofi",
      "planner.chip.quieter",
      "planner.chip.remove",
    ]);
  });

  it("uses a vocal vocabulary for one vocal instrument", () => {
    expect(
      suggestionChips({ roles: ["vocals"], trackCount: 1, sectionCount: 1, wholeSong: false }),
    ).toContain("planner.chip.moreReverb");
  });

  it("mixes the vocabulary for several instruments or parts", () => {
    const expected = [
      "planner.chip.warmer",
      "planner.chip.brighter",
      "planner.chip.moreSpace",
      "planner.chip.quieter",
    ];
    expect(
      suggestionChips({
        roles: ["drums", "vocals"],
        trackCount: 2,
        sectionCount: 1,
        wholeSong: false,
      }),
    ).toEqual(expected);
    expect(
      suggestionChips({ roles: ["vocals"], trackCount: 1, sectionCount: 2, wholeSong: false }),
    ).toEqual(expected);
  });

  it("uses the mixed set for the whole song and for unknown roles", () => {
    expect(
      suggestionChips({ roles: ["synth"], trackCount: 1, sectionCount: 1, wholeSong: true }),
    ).toEqual([
      "planner.chip.warmer",
      "planner.chip.brighter",
      "planner.chip.moreSpace",
      "planner.chip.quieter",
    ]);
    expect(
      suggestionChips({ roles: ["residual"], trackCount: 1, sectionCount: 1, wholeSong: false }),
    ).toContain("planner.chip.warmer");
  });
});
