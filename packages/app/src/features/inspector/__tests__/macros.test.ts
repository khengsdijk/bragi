import type { MacroDrive, MacroId, Project } from "@bragi/schemas";
import { FX_CATALOG, MACROS } from "@bragi/schemas";
import { describe, expect, it } from "vitest";
import { loadDemo } from "../../song/__tests__/fixtures.js";
import {
  catalogueDefaults,
  interpolate,
  invert,
  type MacroScope,
  macroBatch,
  macroValue,
} from "../macros.js";

/** The demo's drums track: every macro is applied there unless a test says otherwise. */
const DRUMS: MacroScope = { kind: "track", trackId: "trk_drums" };

/** A fixed clock, so a batch's `createdAt` is deterministic. */
const NOW = new Date("2026-10-19T12:00:00Z");

/** Values across the bipolar range, including the neutral point. */
const GRID = [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1];

/** The document loaded through the real `bragi-model` wasm. */
async function loadedDoc(): Promise<{
  doc: Project;
  store: Awaited<ReturnType<typeof loadDemo>>["store"];
}> {
  const { store } = await loadDemo();
  const doc = store.store.getState().doc;
  if (doc === null) throw new Error("the demo did not load a document");
  return { doc, store };
}

/** The catalogue's numeric spec for a drive, with the narrowing the assertions need. */
function numericSpec(drive: MacroDrive): { min: number; max: number; default: number } {
  const entry = FX_CATALOG.fx[drive.fx];
  if (entry === undefined) throw new Error(`no catalogue entry for ${drive.fx}`);
  const spec = entry.params[drive.param];
  if (spec === undefined) throw new Error(`no catalogue param ${drive.fx}.${drive.param}`);
  if (spec.type !== "number") throw new Error(`${drive.fx}.${drive.param} has no numeric range`);
  return { min: spec.min, max: spec.max, default: spec.default };
}

describe("the macro catalogue", () => {
  it("has the seven v1 macros with the vibe-slider labels", () => {
    expect(MACROS.macros.map((macro) => macro.id)).toEqual([
      "brightness",
      "space",
      "punch",
      "warmth",
      "vintage",
      "intensity",
      "distance",
    ]);
    expect(MACROS.macros.map((macro) => macro.label)).toEqual([
      "Darker ↔ Brighter",
      "Dry ↔ Spacious",
      "Soft ↔ Punchy",
      "Clean ↔ Warm",
      "Modern ↔ Vintage",
      "Calm ↔ Intense",
      "Close ↔ Distant",
    ]);
  });

  it.each(MACROS.macros.map((macro) => [macro.id, macro] as const))(
    "%s stays inside the catalogue and is neutral at 0",
    (id, macro) => {
      expect(macro.range).toEqual([-1, 1]);
      const pairs = new Set<string>();
      for (const drive of macro.drives) {
        const pair = `${drive.fx}.${drive.param}`;
        expect(pairs.has(pair), `${id} drives ${pair} twice`).toBe(false);
        pairs.add(pair);

        const spec = numericSpec(drive);
        let previousX = Number.NEGATIVE_INFINITY;
        for (const [x, y] of drive.curve) {
          expect(x, `${id} ${pair} x is increasing`).toBeGreaterThan(previousX);
          previousX = x;
          expect(y, `${id} ${pair} y at ${x}`).toBeGreaterThanOrEqual(spec.min);
          expect(y, `${id} ${pair} y at ${x}`).toBeLessThanOrEqual(spec.max);
        }
        expect(drive.curve[0]?.[0], `${id} ${pair} starts at the range minimum`).toBe(-1);
        expect(drive.curve.at(-1)?.[0], `${id} ${pair} ends at the range maximum`).toBe(1);
        expect(
          drive.curve.some(([x]) => x === 0),
          `${id} ${pair} includes x = 0`,
        ).toBe(true);
        expect(interpolate(drive.curve, 0), `${id} ${pair} is neutral at 0`).toBeCloseTo(
          spec.default,
          10,
        );

        if (drive.mode !== undefined) {
          const mode = FX_CATALOG.fx[drive.fx]?.params.mode;
          expect(mode?.type, `${id} ${drive.fx} mode exists`).toBe("number");
          if (mode?.type === "number") {
            expect(drive.mode).toBeGreaterThanOrEqual(mode.min);
            expect(drive.mode).toBeLessThanOrEqual(mode.max);
          }
        }
      }
    },
  );

  it("reads catalogue defaults as a parameter map", () => {
    expect(catalogueDefaults("filter")).toEqual({ mode: 0, cutoffHz: 20000, resonance: 0.2 });
    expect(catalogueDefaults("reverb")).toEqual({
      size: 0.5,
      decaySec: 2,
      predelayMs: 20,
      damping: 0.5,
      mix: 0.2,
    });
  });
});

describe("curve maths", () => {
  it("interpolates linearly and clamps outside the curve", () => {
    const curve: [number, number][] = [
      [-1, -9],
      [0, 0],
      [1, 6],
    ];
    expect(interpolate(curve, 0)).toBe(0);
    expect(interpolate(curve, 0.5)).toBe(3);
    expect(interpolate(curve, -0.5)).toBe(-4.5);
    expect(interpolate(curve, -2)).toBe(-9);
    expect(interpolate(curve, 2)).toBe(6);
  });

  it("round-trips every monotonic catalogue curve", () => {
    for (const macro of MACROS.macros) {
      for (const drive of macro.drives) {
        const points = drive.curve.map((point) => point[1]);
        const increasing = points.every((y, index) => index === 0 || y > (points[index - 1] ?? y));
        const decreasing = points.every((y, index) => index === 0 || y < (points[index - 1] ?? y));
        if (!increasing && !decreasing) continue;
        for (const x of GRID) {
          expect(invert(drive.curve, interpolate(drive.curve, x))).toBeCloseTo(x, 9);
        }
      }
    }
  });

  it("clamps the inverse outside the curve", () => {
    const curve: [number, number][] = [
      [-1, 0.1],
      [0, 0.2],
      [1, 0.5],
    ];
    expect(invert(curve, 0)).toBe(-1);
    expect(invert(curve, 1)).toBe(1);
  });
});

describe("macroBatch through bragi-model", () => {
  it("round-trips every macro over the whole value range", async () => {
    const { doc: initial, store } = await loadedDoc();
    let doc = initial;
    for (const macro of MACROS.macros) {
      for (const value of GRID) {
        const batch = macroBatch(doc, DRUMS, macro.id, value, NOW);
        expect(batch, `${macro.id} at ${value} produces a batch`).not.toBeNull();
        if (batch === null) continue;
        const outcome = store.apply(batch);
        if (!outcome.ok) {
          throw new Error(`${macro.id} at ${value}: ${JSON.stringify(outcome.errors)}`);
        }
        doc = outcome.doc;
        expect(macroValue(doc, DRUMS, macro.id), `${macro.id} at ${value}`).toBeCloseTo(value, 3);
      }
    }
    expect(store.store.getState().doc).toEqual(doc);
  });

  it("applies the same value twice as a no-op", async () => {
    const { doc, store } = await loadedDoc();
    for (const macro of MACROS.macros) {
      const first = macroBatch(doc, DRUMS, macro.id, 0.37, NOW);
      if (first === null) throw new Error(`${macro.id} produced no batch`);
      const outcome = store.apply(first);
      if (!outcome.ok) throw new Error(`${macro.id}: ${JSON.stringify(outcome.errors)}`);
      expect(macroValue(outcome.doc, DRUMS, macro.id)).toBeCloseTo(0.37, 3);
      expect(macroBatch(outcome.doc, DRUMS, macro.id, 0.37, NOW)).toBeNull();
    }
  });

  it("keeps an older document at its old value (undo)", async () => {
    const { doc, store } = await loadedDoc();
    const low = macroBatch(doc, DRUMS, "brightness", -0.4, NOW);
    if (low === null) throw new Error("no batch");
    const afterLow = store.apply(low);
    if (!afterLow.ok) throw new Error(JSON.stringify(afterLow.errors));

    const high = macroBatch(afterLow.doc, DRUMS, "brightness", 0.8, NOW);
    if (high === null) throw new Error("no batch");
    const afterHigh = store.apply(high);
    if (!afterHigh.ok) throw new Error(JSON.stringify(afterHigh.errors));

    expect(macroValue(afterHigh.doc, DRUMS, "brightness")).toBeCloseTo(0.8, 3);
    expect(macroValue(afterLow.doc, DRUMS, "brightness")).toBeCloseTo(-0.4, 3);
    expect(macroValue(doc, DRUMS, "brightness")).toBe(0);
  });

  it("tags added instances with macroOwned and appends them to the chain", async () => {
    const { doc, store } = await loadedDoc();
    const before = doc.tracks.find((track) => track.id === "trk_drums")?.fx.length ?? 0;
    const batch = macroBatch(doc, DRUMS, "space", 1, NOW);
    if (batch === null) throw new Error("no batch");
    const outcome = store.apply(batch);
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.errors));
    const chain = outcome.doc.tracks.find((track) => track.id === "trk_drums")?.fx ?? [];
    const owned = chain.filter((fx) => fx.macroOwned === "space");
    expect(chain.length).toBeGreaterThan(before);
    expect(owned.map((fx) => fx.type).sort()).toEqual(["reverb", "width"]);
    expect(owned.every((fx) => fx.bypass === false)).toBe(true);
    expect(owned.find((fx) => fx.type === "reverb")?.params).toEqual({
      size: 0.85,
      decaySec: 6,
      predelayMs: 20,
      damping: 0.5,
      mix: 0.55,
    });
  });

  it("labels the batch from i18n", async () => {
    const { doc } = await loadedDoc();
    expect(macroBatch(doc, DRUMS, "space", 0.5, NOW)?.label).toBe("Space on Drums");
    expect(macroBatch(doc, { kind: "master" }, "distance", 0.5, NOW)?.label).toBe(
      "Distance on Master",
    );
  });

  it("tracks a manual parameter edit in the slider", async () => {
    const { doc, store } = await loadedDoc();
    const batch = macroBatch(doc, DRUMS, "brightness", 1, NOW);
    if (batch === null) throw new Error("no batch");
    const applied = store.apply(batch);
    if (!applied.ok) throw new Error(JSON.stringify(applied.errors));
    const eq3 = applied.doc.tracks
      .find((track) => track.id === "trk_drums")
      ?.fx.find((fx) => fx.type === "eq3" && fx.macroOwned === "brightness");
    if (eq3 === undefined) throw new Error("the macro did not add an eq3");

    const edit = store.apply({
      id: "bat_01MANUALEDIT00000000000000",
      author: { kind: "user" },
      label: "Set the high shelf",
      ops: [{ op: "fx.update", fxId: eq3.id, paramsPatch: { highDb: -3 } }],
      createdAt: NOW.toISOString(),
    });
    if (!edit.ok) throw new Error(JSON.stringify(edit.errors));
    // The brightness curve is [-1,-9],[0,0],[1,6], so -3 dB is one third of the way down.
    expect(macroValue(edit.doc, DRUMS, "brightness")).toBeCloseTo(-1 / 3, 6);
  });

  it("works on the master chain and rejects an unknown track", async () => {
    const { doc, store } = await loadedDoc();
    const batch = macroBatch(doc, { kind: "master" }, "distance", 1, NOW);
    if (batch === null) throw new Error("no batch");
    const outcome = store.apply(batch);
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.errors));
    expect(macroValue(outcome.doc, { kind: "master" }, "distance")).toBeCloseTo(1, 3);
    expect(outcome.doc.arrangement.master.fx.some((fx) => fx.macroOwned === "distance")).toBe(true);
    expect(macroBatch(doc, { kind: "track", trackId: "trk_ghost" }, "space", 1, NOW)).toBeNull();
    expect(macroValue(doc, { kind: "track", trackId: "trk_ghost" }, "space")).toBe(0);
  });

  it("returns null for a macro id that the catalogue does not define", async () => {
    const { doc } = await loadedDoc();
    expect(macroBatch(doc, DRUMS, "mac_unknown" as MacroId, 1, NOW)).toBeNull();
    expect(macroValue(doc, DRUMS, "mac_unknown" as MacroId)).toBe(0);
  });
});
