import { describe, expect, it } from "vitest";

import { buildDemoProject, fakeAssetHash, SHORT_DEMO } from "../../song/api/demo-song.js";
import { type PlannerAnalysis, sectionFeaturesFor } from "../section-features.js";

const built = buildDemoProject(SHORT_DEMO, { assetFor: (key) => fakeAssetHash(key) });
const doc = built.project;

/** 120 BPM, PPQ 960. */
const secondsAtTick = (tick: number): number => tick / 1920;

const analysis: PlannerAnalysis = {
  energy: { values: Float32Array.from([0.2, 0.4, 0.6, 0.8]), hopSec: 1 },
  chords: [
    { startSec: 0, endSec: 1, label: "i", rootPitchClass: 0, quality: "minor", tension: 0.15 },
    { startSec: 1, endSec: 3, label: "VI", rootPitchClass: 8, quality: "major", tension: 0.25 },
    { startSec: 3, endSec: 4, label: "i", rootPitchClass: 0, quality: "minor", tension: 0.15 },
  ],
  ribbons: {
    trk_drums: { rms: { values: Float32Array.from([1, 1, 1, 1]), hopSec: 1 } },
    trk_bass: { rms: { values: Float32Array.from([0.02, 0.02, 0.02, 0.02]), hopSec: 1 } },
  },
};

describe("section features", () => {
  it("condenses energy, chords and active stems per section", () => {
    const features = sectionFeaturesFor(doc, analysis, secondsAtTick);
    expect(features).toHaveLength(doc.arrangement.sections.length);
    const intro = features[0];
    expect(intro?.sectionId).toBe(doc.arrangement.sections[0]?.id);
    expect(intro?.energy).toBeCloseTo(0.5);
    expect(intro?.chords).toEqual(["i", "VI"]);
    expect(intro?.activeStems).toEqual(["trk_drums"]);
  });

  it("omits features that the analysis does not have", () => {
    expect(sectionFeaturesFor(doc, null, secondsAtTick)).toEqual([]);
    const noChords = sectionFeaturesFor(
      doc,
      { energy: { values: Float32Array.from([0.2, 0.4, 0.6, 0.8]), hopSec: 1 } },
      secondsAtTick,
    );
    expect(noChords[0]?.chords).toBeUndefined();
    expect(noChords[0]?.activeStems).toBeUndefined();
  });
});
