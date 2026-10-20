import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  activityMask,
  buildRibbonStrip,
  buildWaveformStrip,
  catmullRom,
  cullWindow,
  gridLines,
  resampleCurve,
  ribbonTexturePixels,
  sampleCurve,
  skylineOutline,
  windowCovers,
} from "../geometry.js";
import { computeLayout, hitTest, sectionAt, sectionAtPoint } from "../layout.js";
import { chordFill, energyColor, hexToNumber, paletteFromTokens, readableOn } from "../palette.js";
import { appeared, isAnalysing, layerStates, shimmerPhase } from "../progressive.js";
import {
  clickSelection,
  decodeSelection,
  encodeSelection,
  NO_SELECTION,
  pruneSelection,
} from "../selection.js";
import type { AnalysisView, CanvasDocument, Selection } from "../types.js";
import {
  clampViewport,
  fitSong,
  lodBinsPerSecond,
  panBy,
  pxPerSecond,
  revealTime,
  timeToX,
  xToTime,
  zoomAt,
  zoomLevel,
} from "../viewport.js";

function doc(overrides: Partial<CanvasDocument> = {}): CanvasDocument {
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
    tracks: [
      { id: "trk_d", name: "Drums", role: "drums", mute: false, solo: false, hidden: false },
      { id: "trk_b", name: "Bass", role: "bass", mute: false, solo: false, hidden: false },
    ],
    clips: [],
    ...overrides,
  };
}

describe("zoom levels (07 §2.1)", () => {
  it("maps px per beat onto the four levels with the boundaries on the higher level", () => {
    expect(zoomLevel(3.99)).toBe("L2-far");
    expect(zoomLevel(4)).toBe("L2");
    expect(zoomLevel(23.9)).toBe("L2");
    expect(zoomLevel(24)).toBe("L2-near");
    expect(zoomLevel(63.9)).toBe("L2-near");
    expect(zoomLevel(64)).toBe("L3");
  });

  it("converts between time and x consistently", () => {
    const viewport = { pxPerBeat: 20, originSec: 5 };
    expect(pxPerSecond(20, 120)).toBe(40);
    expect(timeToX(viewport, 120, 7)).toBe(80);
    expect(xToTime(viewport, 120, 80)).toBe(7);
  });

  it("zooms anchored at the cursor: the time under the cursor does not move", () => {
    const start = { pxPerBeat: 8, originSec: 10 };
    const anchorX = 300;
    const before = xToTime(start, 120, anchorX);
    const next = zoomAt(start, 120, 600, 1000, 2, anchorX);
    expect(next.pxPerBeat).toBe(16);
    expect(xToTime(next, 120, anchorX)).toBeCloseTo(before, 9);
  });

  it("clamps pan to the song and zoom to the allowed range", () => {
    const viewport = { pxPerBeat: 8, originSec: 0 };
    expect(panBy(viewport, 120, 60, 400, 5000).originSec).toBe(0);
    const panned = panBy(viewport, 120, 60, 400, -1e9);
    // 400 px at 16 px/s shows 25 s, so the last origin is 60 - 25.
    expect(panned.originSec).toBeCloseTo(35, 9);
    expect(clampViewport({ pxPerBeat: 1e6, originSec: 0 }, 120, 60, 400).pxPerBeat).toBe(512);
    expect(clampViewport({ pxPerBeat: 0, originSec: 0 }, 120, 60, 400).pxPerBeat).toBe(0.25);
  });

  it("fits the whole song in the window", () => {
    const viewport = fitSong(120, 240, 960);
    expect(viewport.originSec).toBe(0);
    expect(timeToX(viewport, 120, 240)).toBeCloseTo(960, 6);
  });

  it("follows the playhead without moving while it is in view", () => {
    const viewport = { pxPerBeat: 8, originSec: 0 };
    expect(revealTime(viewport, 120, 600, 400, 5)).toBe(viewport);
    const moved = revealTime(viewport, 120, 600, 400, 100);
    expect(timeToX(moved, 120, 100)).toBeGreaterThanOrEqual(0);
    expect(timeToX(moved, 120, 100)).toBeLessThanOrEqual(400);
  });

  it("steps the level of detail in powers of two so a zoom gesture does not rebuild per frame", () => {
    expect(lodBinsPerSecond(40, 1000)).toBe(64);
    expect(lodBinsPerSecond(41, 1000)).toBe(64);
    expect(lodBinsPerSecond(100, 50)).toBe(50);
  });
});

describe("selection (07 §5)", () => {
  const cases: Selection[] = [
    { kind: "sections", ids: ["sec_01", "sec_02"] },
    { kind: "tracks", ids: ["trk_mix"] },
    { kind: "clips", ids: ["clp_a", "clp_b", "clp_c"] },
    { kind: "region", region: { startTick: 3840, endTick: 15360, tracks: ["trk_a", "trk_b"] } },
    { kind: "region", region: { startTick: 0, endTick: 960, tracks: "all" } },
  ];

  it.each(cases)("round-trips through the URL form: %j", (selection) => {
    expect(decodeSelection(encodeSelection(selection))).toEqual(selection);
  });

  it("encodes none as nothing and treats malformed input as none", () => {
    expect(encodeSelection(NO_SELECTION)).toBe("");
    for (const bad of ["", "x:1", "s:", "s:a b", "r:5-3:trk_a", "r:1-2:", "s", "t:a,,b", null]) {
      expect(decodeSelection(bad)).toEqual(NO_SELECTION);
    }
  });

  it("replaces on a plain click and toggles on an additive one", () => {
    const one = clickSelection(NO_SELECTION, "sections", "sec_a", false);
    expect(one).toEqual({ kind: "sections", ids: ["sec_a"] });
    const two = clickSelection(one, "sections", "sec_b", true);
    expect(two).toEqual({ kind: "sections", ids: ["sec_a", "sec_b"] });
    expect(clickSelection(two, "sections", "sec_a", true)).toEqual({
      kind: "sections",
      ids: ["sec_b"],
    });
    expect(clickSelection(one, "tracks", "trk_a", true)).toEqual({
      kind: "tracks",
      ids: ["trk_a"],
    });
    expect(clickSelection(one, "sections", "sec_a", true)).toEqual(NO_SELECTION);
  });

  it("prunes ids that no longer exist", () => {
    const selection: Selection = { kind: "sections", ids: ["sec_a", "sec_gone"] };
    const pruned = pruneSelection(selection, (_kind, id) => id !== "sec_gone");
    expect(pruned).toEqual({ kind: "sections", ids: ["sec_a"] });
    expect(pruneSelection(selection, () => false)).toEqual(NO_SELECTION);
  });
});

describe("geometry (07 §9)", () => {
  it("samples a curve with linear interpolation and clamps at the ends", () => {
    const curve = { values: [0, 1, 0], hopSec: 1 };
    expect(sampleCurve(curve, -5)).toBe(0);
    expect(sampleCurve(curve, 0.5)).toBe(0.5);
    expect(sampleCurve(curve, 1)).toBe(1);
    expect(sampleCurve(curve, 99)).toBe(0);
    expect(sampleCurve({ values: [], hopSec: 1 }, 3)).toBe(0);
  });

  it("keeps the peak when it resamples to fewer bins than the source", () => {
    const values = new Float32Array(100);
    values[37] = 1;
    const out = resampleCurve({ values, hopSec: 0.1 }, 0, 1, 10);
    expect(out.length).toBe(10);
    expect(Math.max(...out)).toBe(1);
    expect(out[3]).toBe(1);
  });

  it("passes the Catmull-Rom curve through every input point", () => {
    const points = new Float32Array([0, 0, 10, 5, 20, 0, 30, 8]);
    const out = catmullRom(points, 4);
    expect(out.length).toBe(((4 - 1) * 4 + 1) * 2);
    for (let i = 0; i < 4; i += 1) {
      expect(out[i * 4 * 2]).toBeCloseTo(points[i * 2] ?? 0, 5);
      expect(out[i * 4 * 2 + 1]).toBeCloseTo(points[i * 2 + 1] ?? 0, 5);
    }
  });

  it("puts a full-energy skyline bin at the top and an empty one at the bottom", () => {
    const outline = skylineOutline(new Float32Array([1, 0, 1]), 1, 10, 48, 1);
    expect(outline.top[1]).toBe(0);
    expect(outline.top[3]).toBe(48);
  });

  it("culls to the viewport plus a screen on each side", () => {
    const window = cullWindow(100, 20, 600);
    expect(window).toEqual({ startSec: 80, endSec: 140 });
    expect(windowCovers(window, 100, 20, 600)).toBe(true);
    expect(windowCovers(window, 70, 20, 600)).toBe(false);
    expect(cullWindow(5, 20, 30)).toEqual({ startSec: 0, endSec: 30 });
  });

  it("builds a triangle strip with three vertices per bin and a thin line where inactive", () => {
    const strip = buildRibbonStrip({
      thickness: new Float32Array([1, 1, 0.5]),
      active: new Uint8Array([1, 0, 1]),
      firstBin: 0,
      binsPerSecond: 2,
      worldPxPerSec: 20,
      halfHeightPx: 16,
      offsetPx: 0,
    });
    expect(strip.bins).toBe(3);
    expect(strip.positions.length).toBe(18);
    expect(strip.indices.length).toBe(24);
    // Active, full-thickness bin spans the whole half height; the inactive one is a hairline.
    expect(strip.positions[1]).toBe(-16);
    expect(strip.positions[5]).toBe(16);
    expect(strip.positions[7]).toBeCloseTo(-0.6, 6);
    // Bin centres sit half a bin in (10 px per bin).
    expect(strip.positions[0]).toBe(5);
    expect(strip.positions[6]).toBe(15);
    // Every index refers to an existing vertex.
    expect(Math.max(...strip.indices)).toBeLessThan(9);
  });

  it("adds grain only to noisy active bins and keeps it deterministic", () => {
    const base = {
      thickness: new Float32Array(32).fill(0.5),
      active: new Uint8Array(32).fill(1),
      firstBin: 100,
      binsPerSecond: 2,
      worldPxPerSec: 20,
      halfHeightPx: 16,
      offsetPx: 0,
    };
    const clean = buildRibbonStrip(base);
    const noisy = buildRibbonStrip({ ...base, noisiness: new Float32Array(32).fill(1) });
    const again = buildRibbonStrip({ ...base, noisiness: new Float32Array(32).fill(1) });
    expect(Array.from(noisy.positions)).toEqual(Array.from(again.positions));
    expect(Array.from(noisy.positions)).not.toEqual(Array.from(clean.positions));
  });

  it("makes a 3-row texture whose core is lighter than its edges and whose inactive bins fade", () => {
    const pixels = ribbonTexturePixels([100, 60, 200], {
      thickness: new Float32Array(2),
      active: new Uint8Array([1, 0]),
    });
    expect(pixels.length).toBe(2 * 3 * 4);
    const edge = pixels[0] ?? 0;
    const core = pixels[(1 * 2 + 0) * 4] ?? 0;
    expect(core).toBeGreaterThan(edge);
    expect(pixels[3]).toBeGreaterThan(pixels[7] ?? 255);
  });

  it("marks activity from clip extents", () => {
    const mask = activityMask([{ startSec: 1, endSec: 2 }], 0, 4, 16);
    expect(Array.from(mask)).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("builds a waveform strip from min/max peaks", () => {
    const strip = buildWaveformStrip(
      { min: new Float32Array([-1, -0.5]), max: new Float32Array([1, 0.5]) },
      2,
      20,
      10,
      0,
    );
    expect(strip.positions[1]).toBe(-10);
    expect(strip.positions[5]).toBe(10);
    expect(strip.positions[7]).toBe(-5);
  });

  it("draws every beat when zoomed in and only some bars when zoomed far out", () => {
    const beats = Array.from({ length: 400 }, (_, i) => i * 0.5);
    const near = gridLines(beats, 4, 0, 10, 20);
    expect(near.indices.length).toBe(21);
    expect(near.isBar.filter(Boolean).length).toBe(6);
    const far = gridLines(beats, 4, 0, 200, 1);
    expect(far.isBar.every(Boolean)).toBe(true);
    // 1 px per beat is 4 px per bar: bars are drawn every 4th bar to stay >= 10 px apart.
    expect(far.indices[1]).toBe(16);
    expect(gridLines([], 4, 0, 10, 20).indices).toEqual([]);
  });
});

describe("layout and hit testing", () => {
  const layout = computeLayout({
    width: 1000,
    trackIds: ["trk_d", "trk_b"],
    level: "L2",
    uiScale: 1,
  });
  const viewport = { pxPerBeat: 8, originSec: 0 };
  const song = doc();

  it("stacks the lanes in the order of 07 §1 without overlap", () => {
    expect(layout.ruler.y).toBeLessThan(layout.skyline.y);
    expect(layout.skyline.y + layout.skyline.h).toBeLessThanOrEqual(layout.sections.y);
    expect(layout.sections.y + layout.sections.h).toBeLessThanOrEqual(layout.harmony.y);
    expect(layout.harmony.y + layout.harmony.h).toBeLessThanOrEqual(layout.ribbons[0]?.rect.y ?? 0);
    expect(layout.height).toBeGreaterThan(layout.ribbons[1]?.rect.y ?? 0);
  });

  it("keeps solo and mute buttons at least 24 x 24 (11 §6.4)", () => {
    for (const lane of layout.ribbons) {
      expect(lane.solo.w).toBeGreaterThanOrEqual(24);
      expect(lane.solo.h).toBeGreaterThanOrEqual(24);
      expect(lane.mute.w).toBeGreaterThanOrEqual(24);
    }
  });

  it("grows the lanes with the text size and at the Moment level", () => {
    const big = computeLayout({ width: 1000, trackIds: ["a"], level: "L2", uiScale: 2 });
    const moment = computeLayout({ width: 1000, trackIds: ["a"], level: "L3", uiScale: 1 });
    expect(big.ribbons[0]?.rect.h).toBe(80);
    expect(moment.ribbons[0]?.rect.h).toBe(72);
  });

  it("finds sections by time with a binary search", () => {
    expect(sectionAt(song, 0)).toBe("sec_a");
    expect(sectionAt(song, 19.99)).toBe("sec_a");
    expect(sectionAt(song, 20)).toBe("sec_b");
    expect(sectionAt(song, 60)).toBeNull();
  });

  it("resolves what is under the pointer", () => {
    const lane = layout.ribbons[0];
    expect(lane).toBeDefined();
    if (!lane) return;
    const pxPerSec = pxPerSecond(8, 120);
    const sectionY = layout.sections.y + 4;
    expect(hitTest(layout, viewport, song, layout.gutter + 5 * pxPerSec, sectionY)).toMatchObject({
      kind: "section",
      id: "sec_a",
    });
    expect(hitTest(layout, viewport, song, lane.solo.x + 2, lane.solo.y + 2)).toEqual({
      kind: "toggle",
      trackId: "trk_d",
      field: "solo",
    });
    expect(hitTest(layout, viewport, song, lane.mute.x + 2, lane.mute.y + 2)).toEqual({
      kind: "toggle",
      trackId: "trk_d",
      field: "mute",
    });
    expect(hitTest(layout, viewport, song, layout.gutter + 100, lane.rect.y + 5)).toMatchObject({
      kind: "ribbon",
      trackId: "trk_d",
    });
    expect(hitTest(layout, viewport, song, layout.gutter + 100, layout.ruler.y + 2)).toMatchObject({
      kind: "ruler",
    });
    expect(hitTest(layout, viewport, song, layout.gutter + 100, layout.skyline.y + 2)).toEqual({
      kind: "skyline",
    });
    expect(hitTest(layout, viewport, song, 5, layout.harmony.y + 2)).toEqual({ kind: "none" });
    // The context-menu hit test only answers for the section lane.
    expect(sectionAtPoint(layout, viewport, song, layout.gutter + 5 * pxPerSec, sectionY)).toBe(
      "sec_a",
    );
    expect(sectionAtPoint(layout, viewport, song, layout.gutter + 100, lane.rect.y + 5)).toBeNull();
  });
});

describe("progressive states (07 §8)", () => {
  const ingestOnly = doc({
    beatTimesSec: [],
    sections: [
      {
        id: "sec_song",
        kind: "custom",
        label: "Song",
        startSec: 0,
        endSec: 60,
        bars: 30,
        locked: false,
      },
    ],
    tracks: [
      {
        id: "trk_mix",
        name: "Full song",
        role: "full_mix",
        mute: false,
        solo: false,
        hidden: false,
      },
    ],
  });

  it("shows a single block and a playable mix, with shimmer where analysis is still due", () => {
    const analysis: AnalysisView = {
      stages: {
        ingest: "done",
        rhythm: "running",
        loudness_energy: "pending",
        structure: "pending",
        separation: "pending",
        harmony: "pending",
      },
    };
    expect(layerStates(ingestOnly, analysis)).toEqual({
      grid: "pending",
      skyline: "pending",
      sections: "pending",
      stems: "pending",
      harmony: "pending",
    });
    expect(isAnalysing(analysis)).toBe(true);
  });

  it("goes live as the data arrives, whatever the status table says", () => {
    const analysis: AnalysisView = {
      stages: { rhythm: "done", loudness_energy: "done", harmony: "failed" },
      energy: { values: [0.1, 0.2], hopSec: 1 },
    };
    const states = layerStates(doc(), analysis);
    expect(states.grid).toBe("live");
    expect(states.skyline).toBe("live");
    expect(states.sections).toBe("live");
    expect(states.stems).toBe("live");
    expect(states.harmony).toBe("failed");
    expect(isAnalysing(analysis)).toBe(false);
  });

  it("draws nothing for a stage that is not part of the analysis", () => {
    expect(layerStates(ingestOnly, null).skyline).toBe("absent");
    expect(isAnalysing(null)).toBe(false);
  });

  it("reports which ids appeared and holds the shimmer still when motion is reduced", () => {
    expect(appeared(["a"], ["a", "b", "c"])).toEqual(["b", "c"]);
    expect(shimmerPhase(0, 0, true)).toBe(0.5);
    expect(shimmerPhase(500, 120, true)).toBe(0.5);
    expect(shimmerPhase(500, 120, false)).not.toBe(0.5);
  });
});

describe("palette (11 §3)", () => {
  const tokens = JSON.parse(
    readFileSync(new URL("../../../design/tokens.json", import.meta.url), "utf8"),
  ) as {
    themes: {
      dark: Parameters<typeof paletteFromTokens>[0];
      light: Parameters<typeof paletteFromTokens>[0];
    };
  };
  const dark = paletteFromTokens(tokens.themes.dark, "dark");
  const light = paletteFromTokens(tokens.themes.light, "light");

  it("reads the role, section and energy colours from the token file", () => {
    expect(dark.roles.drums).toBe(hexToNumber("#ffab46"));
    expect(dark.sectionFill.blue).toBe(hexToNumber("#a5ccf4"));
    expect(dark.energy).toHaveLength(5);
    expect(light.canvas).not.toBe(dark.canvas);
  });

  it("interpolates the energy gradient between its stops", () => {
    expect(energyColor(dark, 0)).toBe(dark.energy[0]);
    expect(energyColor(dark, 1)).toBe(dark.energy[4]);
    expect(energyColor(dark, 0.5)).toBe(dark.energy[2]);
  });

  it("colours chords by circle of fifths with major lighter than minor", () => {
    const major = chordFill({ rootPitchClass: 0, quality: "major" }, "dark");
    const minor = chordFill({ rootPitchClass: 0, quality: "minor" }, "dark");
    expect(major).not.toBe(minor);
    // C and G are neighbours on the circle of fifths: their hues are 30 degrees apart.
    const c = chordFill({ rootPitchClass: 0, quality: "major" }, "dark");
    const g = chordFill({ rootPitchClass: 7, quality: "major" }, "dark");
    const f = chordFill({ rootPitchClass: 5, quality: "major" }, "dark");
    expect(new Set([c, g, f]).size).toBe(3);
  });

  it("picks dark text on a light fill and light text on a dark one", () => {
    expect(readableOn(0xffffff)).toBe(0x10141c);
    expect(readableOn(0x000000)).toBe(0xf6f8fc);
  });
});
