import { describe, expect, it } from "vitest";

import harmony from "../../../../../schemas/examples/HarmonyResult.json" with { type: "json" };
import loudness from "../../../../../schemas/examples/LoudnessEnergyResult.json" with {
  type: "json",
};
import activity from "../../../../../schemas/examples/StemActivityResult.json" with {
  type: "json",
};
import {
  artifactsForStage,
  chordQuality,
  chordsFromHarmony,
  energyCurve,
  mergeArtifacts,
  peaksFromIngest,
  pitchClass,
  ribbonsFromStemActivity,
} from "../api/analysis-view.js";

describe("pitchClass", () => {
  it("maps note names, sharps and flats to 0..11", () => {
    expect(pitchClass("C")).toBe(0);
    expect(pitchClass("C#")).toBe(1);
    expect(pitchClass("Bb")).toBe(10);
    expect(pitchClass("F#")).toBe(6);
    expect(pitchClass("")).toBe(0);
  });
});

describe("chordQuality", () => {
  it("maps the blob's quality strings to the four outline classes", () => {
    expect(chordQuality("maj7")).toBe("major");
    expect(chordQuality("min7")).toBe("minor");
    expect(chordQuality("dim")).toBe("diminished");
    expect(chordQuality("sus4")).toBe("suspended");
  });
});

describe("energyCurve", () => {
  it("reads the loudness_energy series", () => {
    const curve = energyCurve(loudness);
    expect(curve?.hopSec).toBe(0.5);
    expect(curve?.values[0]).toBeCloseTo(0.31, 4);
    expect(curve?.values[1]).toBeCloseTo(0.44, 4);
  });

  it("returns undefined for a blob that is not a LoudnessEnergyResult", () => {
    expect(energyCurve({ hopSec: 1 })).toBeUndefined();
  });
});

describe("chordsFromHarmony", () => {
  it("maps chords to the canvas strip", () => {
    expect(chordsFromHarmony(harmony)).toEqual([
      {
        startSec: 0,
        endSec: 1,
        label: "F#m7",
        rootPitchClass: 6,
        quality: "minor",
        tension: 0.15,
      },
    ]);
  });
});

describe("ribbonsFromStemActivity", () => {
  it("is opaque exactly where the stem is gated open", () => {
    const ribbons = ribbonsFromStemActivity(activity, {
      tracks: [{ id: "trk_vocals", role: "vocals" }],
    });
    expect(ribbons).toBeDefined();
    const rms = ribbons?.trk_vocals?.rms;
    expect(rms?.hopSec).toBe(0.25);
    expect(rms?.values[0]).toBe(0); // t = 0.0, before the gate
    expect(rms?.values[2]).toBe(1); // t = 0.5, gate open
    expect(rms?.values[48]).toBe(0); // t = 12.0, end is exclusive
  });

  it("returns undefined when no track's role has activity", () => {
    expect(
      ribbonsFromStemActivity(activity, { tracks: [{ id: "t", role: "drums" }] }),
    ).toBeUndefined();
  });
});

describe("peaksFromIngest", () => {
  it("reads min/max pairs from the peak pyramid", () => {
    const peaks = peaksFromIngest({
      schemaVersion: 1,
      workingAsset: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      durationSec: 0.2,
      channelsOriginal: 1,
      sampleRateOriginal: 48000,
      codec: "wav",
      fingerprint: "x",
      peakPyramid: {
        sampleRate: 48000,
        levels: [{ samplesPerPeak: 4800, peaks: [0, 1, -0.5, 0.5] }],
      },
    });
    const window = peaks?.("trk", 0, 0.2, 2);
    expect(window).not.toBeNull();
    expect(Array.from(window?.min ?? [])).toEqual([0, -0.5]);
    expect(Array.from(window?.max ?? [])).toEqual([1, 0.5]);
  });

  it("returns undefined without a pyramid", () => {
    expect(peaksFromIngest({ schemaVersion: 1 })).toBeUndefined();
  });
});

describe("artifactsForStage", () => {
  it("routes each stage to its projection", () => {
    expect(artifactsForStage("ingest", { schemaVersion: 1 }, { tracks: [] })).toEqual({});
    expect(artifactsForStage("loudness_energy", loudness, { tracks: [] })).toHaveProperty("energy");
    expect(artifactsForStage("harmony", harmony, { tracks: [] })).toHaveProperty("chords");
    expect(artifactsForStage("structure", {}, { tracks: [] })).toEqual({});
  });
});

describe("mergeArtifacts", () => {
  it("merges ribbons per track and replaces other fields", () => {
    const first = mergeArtifacts({}, { ribbons: { a: { rms: { values: [1], hopSec: 1 } } } });
    const merged = mergeArtifacts(first, {
      ribbons: { b: { rms: { values: [0], hopSec: 1 } } },
      chords: [],
    });
    expect(Object.keys(merged.ribbons ?? {}).sort()).toEqual(["a", "b"]);
    expect(merged.chords).toEqual([]);
  });
});
