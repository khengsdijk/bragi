import { describe, expect, it } from "vitest";

import { benchmarkSpec, progressiveSpec, SHORT_DEMO } from "../api/demo-song.js";
import { buildCanvasDocument, repeatGroups, stagesFromDocument } from "../api/view-model.js";
import { loadDemo } from "./fixtures.js";

describe("view model", () => {
  it("derives section times from the tempo map in bragi-model", async () => {
    const { store, model } = await loadDemo();
    const handle = store.handle();
    const doc = store.store.getState().doc;
    if (handle === null || doc === null) throw new Error("no document");
    const view = buildCanvasDocument(model, handle, doc);
    // 120 BPM, 4/4: a bar is 2 s. Intro 2, Verse 4, Chorus 4, Bridge 2, Chorus 4 bars.
    expect(view.durationSec).toBeCloseTo(32, 9);
    expect(view.bpm).toBe(120);
    expect(view.beatsPerBar).toBe(4);
    expect(view.sections.map((s) => [s.label, s.startSec, s.endSec, s.bars])).toEqual([
      ["Intro", 0, 4, 2],
      ["Verse 1", 4, 12, 4],
      ["Chorus 1", 12, 20, 4],
      ["Bridge", 20, 24, 2],
      ["Chorus 2", 24, 32, 4],
    ]);
    // 16 bars x 4 beats, 0.5 s apart.
    expect(view.beatTimesSec).toHaveLength(64);
    expect(view.beatTimesSec[1]).toBeCloseTo(0.5, 9);
    expect(view.beatTimesSec[63]).toBeCloseTo(31.5, 9);
  });

  it("reports where each instrument has audio", async () => {
    const { store, model } = await loadDemo();
    const handle = store.handle();
    const doc = store.store.getState().doc;
    if (handle === null || doc === null) throw new Error("no document");
    const view = buildCanvasDocument(model, handle, doc);
    const drums = view.clips.filter((clip) => clip.trackId === "trk_drums");
    expect(drums.map((clip) => [clip.startSec, clip.endSec])).toEqual([
      [4, 12],
      [12, 20],
      [24, 32],
    ]);
    // Every clip lies inside its section.
    for (const clip of view.clips) {
      const section = view.sections.find((candidate) => candidate.id === clip.sectionId);
      expect(clip.startSec).toBeGreaterThanOrEqual(section?.startSec ?? Number.NaN);
      expect(clip.endSec).toBeLessThanOrEqual(section?.endSec ?? Number.NaN);
    }
  });

  it("marks repeated parts so the canvas can give them a shared glyph", async () => {
    const { project } = await loadDemo();
    const groups = repeatGroups(project);
    expect(groups.get("sec_002")).toBeDefined();
    expect(groups.get("sec_002")).toBe(groups.get("sec_004"));
    expect(groups.has("sec_000")).toBe(false);
    expect(groups.has("sec_001")).toBe(false);
  });

  it("reads the analysis stages recorded in the document", async () => {
    const { project } = await loadDemo();
    expect(stagesFromDocument(project)).toMatchObject({
      ingest: "done",
      rhythm: "done",
      structure: "done",
      harmony: "done",
    });
  });
});

describe("progressive demo specs (07 §8)", () => {
  it("is one block and one full-mix ribbon before structure and separation arrive", () => {
    const spec = progressiveSpec(SHORT_DEMO, new Set(["ingest", "rhythm"]));
    expect(spec.sections).toHaveLength(1);
    expect(spec.sections[0]?.label).toBe("Song");
    expect(spec.stems.map((stem) => stem.role)).toEqual(["full_mix"]);
  });

  it("keeps the parts but still one ribbon between structure and separation", () => {
    const spec = progressiveSpec(SHORT_DEMO, new Set(["structure"]));
    expect(spec.sections).toHaveLength(SHORT_DEMO.sections.length);
    expect(spec.stems).toHaveLength(1);
    expect(spec.sections.every((section) => section.plays.includes("mix"))).toBe(true);
  });

  it("is the unchanged song when everything is done", () => {
    expect(progressiveSpec(SHORT_DEMO, new Set(["structure", "separation"]))).toBe(SHORT_DEMO);
  });
});

describe("benchmark song (07 §9 fixture)", () => {
  it("is ten minutes long with twelve instruments", async () => {
    const spec = benchmarkSpec(10, 12);
    const { store, model } = await loadDemo(spec);
    const handle = store.handle();
    const doc = store.store.getState().doc;
    if (handle === null || doc === null) throw new Error("no document");
    const view = buildCanvasDocument(model, handle, doc);
    expect(view.durationSec).toBeCloseTo(600, 6);
    expect(view.tracks.filter((track) => !track.hidden)).toHaveLength(12);
    expect(new Set(view.tracks.map((track) => track.name)).size).toBe(12);
    expect(view.sections.length).toBeGreaterThan(30);
    expect(view.beatTimesSec).toHaveLength(1200);
    expect(model.validateDoc(handle)).toBeUndefined();
  });
});
