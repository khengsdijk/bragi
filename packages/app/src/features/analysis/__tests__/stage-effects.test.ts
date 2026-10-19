import { describe, expect, it } from "vitest";

import ingest from "../../../../../schemas/examples/IngestResult.json" with { type: "json" };
import rhythm from "../../../../../schemas/examples/RhythmResult.json" with { type: "json" };
import separation from "../../../../../schemas/examples/SeparationResult.json" with {
  type: "json",
};
import structure from "../../../../../schemas/examples/StructureResult.json" with { type: "json" };
import tag from "../../../../../schemas/examples/TagResult.json" with { type: "json" };
import { asAnalysisStage, effectsForStage, StageBlobError } from "../api/stage-effects.js";

describe("effectsForStage (02 §6)", () => {
  it("turns rhythm into a tempo effect at the top of the grid", () => {
    expect(effectsForStage("rhythm", rhythm)).toEqual([
      {
        kind: "tempo",
        tempoMap: [{ tick: 0, bpm: 118, curve: "step" }],
        timeSignatures: [{ bar: 0, numerator: 4, denominator: 4 }],
      },
    ]);
  });

  it("passes structure sections through verbatim", () => {
    expect(effectsForStage("structure", structure)).toEqual([
      { kind: "sections", sections: structure.sections },
    ]);
  });

  it("turns separation into its stems and residual", () => {
    expect(effectsForStage("separation", separation)).toEqual([
      { kind: "separation", stems: separation.stems, residual: separation.residual },
    ]);
  });

  it("keeps only the tag labels, not the scores", () => {
    expect(effectsForStage("tag", tag)).toEqual([
      { kind: "tags", genres: ["synthwave"], moods: ["nostalgic"] },
    ]);
  });

  it("gives ingest no effects (the source already exists)", () => {
    expect(effectsForStage("ingest", ingest)).toEqual([]);
  });

  it("gives a view-only stage no effects", () => {
    expect(effectsForStage("harmony", {})).toEqual([]);
    expect(effectsForStage("loudness_energy", {})).toEqual([]);
    expect(effectsForStage("stem_activity", {})).toEqual([]);
  });

  it("rejects a blob that does not match its stage's schema", () => {
    expect(() => effectsForStage("rhythm", { schemaVersion: 1, bpm: "fast" })).toThrow(
      StageBlobError,
    );
  });
});

describe("asAnalysisStage", () => {
  it("recognises the stage vocabulary and rejects anything else", () => {
    expect(asAnalysisStage("loudness_energy")).toBe("loudness_energy");
    expect(asAnalysisStage("echo")).toBeUndefined();
    expect(asAnalysisStage("tags")).toBeUndefined();
  });
});
