import type { Automation, Op, Project, Region } from "@bragi/schemas";
import { MACROS } from "@bragi/schemas";
import { describe, expect, it } from "vitest";

import { interpolate } from "../../inspector/macros.js";
import { brushBatch, MIN_RAMP_SEC } from "../batches.js";
import type { BrushId, FilterDirection } from "../types.js";
import { BAR, type BrushFixture, documentOf, NOW, openBrushFixture } from "./fixtures.js";

/** Bars 3–4 of the demo: inside Verse 1 (bars 2–6), where the drums play. */
const REGION: Region = { startTick: 3 * BAR, endTick: 4 * BAR, tracks: ["trk_drums"] };

const AUTOMATION_BRUSHES: readonly BrushId[] = [
  "space",
  "warmth",
  "brighter",
  "darker",
  "lofi",
  "louder",
  "quieter",
  "filterSweep",
];

const ALL_BRUSHES: readonly BrushId[] = [...AUTOMATION_BRUSHES, "remove"];

function region(startTick: number, endTick: number, tracks: string[] = ["trk_drums"]): Region {
  return { startTick, endTick, tracks };
}

function lane(doc: Project, sectionId: string, trackId: string): Automation[] {
  const section = doc.arrangement.sections.find((candidate) => candidate.id === sectionId);
  return section?.lanes[trackId]?.automation ?? [];
}

/** The entry for a driven parameter (`…/mix`, `…/gainDb`, …). */
function automationFor(
  doc: Project,
  sectionId: string,
  trackId: string,
  suffix: string,
): Automation | undefined {
  return lane(doc, sectionId, trackId).find((entry) => entry.target.endsWith(`/${suffix}`));
}

async function commitBrush(
  fixture: BrushFixture,
  brush: BrushId,
  target: Region,
  strength: number,
  direction?: FilterDirection,
): Promise<ReturnType<typeof brushBatch>> {
  const batch = brushBatch(
    documentOf(fixture),
    brush,
    { region: target, strength, ...(direction === undefined ? {} : { direction }) },
    fixture.model,
    NOW,
  );
  expect(batch, brush).not.toBeNull();
  if (batch === null) return null;
  const outcome = await fixture.history.commit(batch);
  expect(outcome.ok, `${brush}: ${outcome.ok ? "applied" : JSON.stringify(outcome.errors)}`).toBe(
    true,
  );
  return batch;
}

async function commitOps(fixture: BrushFixture, ops: Op[], label: string): Promise<void> {
  const outcome = await fixture.history.commit({
    id: `bat_${label.replace(/\W/g, "")}`,
    author: { kind: "user" },
    label,
    ops: ops as [Op, ...Op[]],
    createdAt: NOW.toISOString(),
  });
  expect(outcome.ok, outcome.ok ? "applied" : JSON.stringify(outcome.errors)).toBe(true);
}

/**
 * 07 §10 check 3: every automation edge ramp is at least 50 ms, measured back through the real
 * tempo map. Equal-valued neighbours are holds, not ramps, and are skipped.
 */
function expectRampsLongEnough(fixture: BrushFixture, doc: Project): void {
  const handle = fixture.model.loadProject(JSON.stringify(doc));
  try {
    const spans = JSON.parse(fixture.model.sectionSpans(handle)) as {
      startTick: number;
    }[];
    for (const [index, section] of doc.arrangement.sections.entries()) {
      const span = spans[index];
      if (span === undefined) continue;
      for (const [trackId, trackLane] of Object.entries(section.lanes)) {
        for (const entry of trackLane.automation) {
          for (let point = 1; point < entry.points.length; point += 1) {
            const left = entry.points[point - 1];
            const right = entry.points[point];
            if (left === undefined || right === undefined || left.value === right.value) continue;
            const seconds =
              fixture.model.ticksToSeconds(handle, BigInt(span.startTick + right.tick)) -
              fixture.model.ticksToSeconds(handle, BigInt(span.startTick + left.tick));
            expect(
              seconds,
              `${section.id} ${trackId} ${entry.target} ${left.tick}→${right.tick}`,
            ).toBeGreaterThanOrEqual(MIN_RAMP_SEC - 1e-9);
          }
        }
      }
    }
  } finally {
    fixture.model.freeDoc(handle);
  }
}

describe("brushBatch", () => {
  it("commits one batch per brush that applies cleanly and undoes to the same document", async () => {
    for (const brush of ALL_BRUSHES) {
      const fixture = await openBrushFixture();
      await fixture.history.load();
      const before = structuredClone(documentOf(fixture));

      await commitBrush(fixture, brush, REGION, 0.6);
      const after = structuredClone(documentOf(fixture));
      expect(after, brush).not.toEqual(before);
      // One commit, one batch, one undo step.
      expect(fixture.history.store.getState().commits.size, brush).toBe(2);

      const undone = await fixture.history.undo();
      expect(undone?.ok, brush).toBe(true);
      expect(documentOf(fixture), brush).toEqual(before);
    }
  });

  it("labels the batch in plain language", async () => {
    const fixture = await openBrushFixture();
    await fixture.history.load();
    const batch = await commitBrush(fixture, "space", REGION, 0.6);
    expect(batch?.label).toBe("Space on Drums, bar 4");
  });

  it("keeps every automation edge ramp at or above 50 ms at the local tempo", async () => {
    for (const brush of AUTOMATION_BRUSHES) {
      const fixture = await openBrushFixture();
      await fixture.history.load();
      await commitBrush(fixture, brush, REGION, 0.7, brush === "filterSweep" ? "down" : undefined);
      expectRampsLongEnough(fixture, documentOf(fixture));
    }
  });

  it("ramps inside the stroke at a section's start and end, where the lane has no room", async () => {
    for (const brush of AUTOMATION_BRUSHES) {
      const fixture = await openBrushFixture();
      await fixture.history.load();
      // Exactly Verse 1 (bars 2–7): neither edge has room in the lane for an outside ramp.
      const handle = fixture.model.loadProject(JSON.stringify(documentOf(fixture)));
      const spans = JSON.parse(fixture.model.sectionSpans(handle)) as {
        startTick: number;
        endTick: number;
      }[];
      fixture.model.freeDoc(handle);
      const verse = spans[1];
      if (verse === undefined) throw new Error("no second section");
      const before = structuredClone(documentOf(fixture));
      await commitBrush(
        fixture,
        brush,
        region(verse.startTick, verse.endTick),
        0.7,
        brush === "filterSweep" ? "down" : undefined,
      );
      const doc = documentOf(fixture);
      const lane = doc.arrangement.sections[1]?.lanes.trk_drums?.automation ?? [];
      const beforeLane = before.arrangement.sections[1]?.lanes.trk_drums?.automation ?? [];
      for (const entry of lane) {
        if (beforeLane.some((old) => old.target === entry.target)) continue;
        // The value the parameter has outside any automation: the effect's own setting, or the
        // track's fader.
        const [scope, param] = entry.target.split("/");
        const id = scope?.slice(scope.indexOf(":") + 1);
        const track = doc.tracks.find((candidate) => candidate.id === "trk_drums");
        const resting = scope?.startsWith("fx:")
          ? track?.fx.find((fx) => fx.id === id)?.params[param ?? ""]
          : track?.gainDb;
        const first = entry.points[0];
        const last = entry.points.at(-1);
        // The lane starts and ends at the resting value, so the join into the section and out of
        // it has no step; the move to the brushed value is a ramp inside the stroke.
        expect(first?.tick, `${brush} ${entry.target}`).toBe(0);
        expect(first?.value, `${brush} ${entry.target}`).toBeCloseTo(resting ?? Number.NaN, 6);
        expect(last?.tick, `${brush} ${entry.target}`).toBe(verse.endTick - verse.startTick);
        expect(last?.value, `${brush} ${entry.target}`).toBeCloseTo(resting ?? Number.NaN, 6);
      }
      expectRampsLongEnough(fixture, doc);
    }
  });

  it("writes one lane per section for a region across two sections, with relative ticks", async () => {
    const fixture = await openBrushFixture();
    await fixture.history.load();
    // Bars 6–7: the last bar of Verse 1 and the first of Chorus 1.
    await commitBrush(fixture, "space", region(5 * BAR, 7 * BAR), 0.6);
    const doc = documentOf(fixture);

    const verse = automationFor(doc, "sec_001", "trk_drums", "mix");
    const chorus = automationFor(doc, "sec_002", "trk_drums", "mix");
    expect(verse).toBeDefined();
    expect(chorus).toBeDefined();
    // Verse 1 starts at bar 2, so the region starts at 3 bars into its lane.
    expect(verse?.points.some((point) => point.tick === 3 * BAR)).toBe(true);
    // Chorus 1 starts exactly where the region continues.
    expect(chorus?.points.some((point) => point.tick === 0)).toBe(true);

    for (const [sectionId, entry] of [
      ["sec_001", verse],
      ["sec_002", chorus],
    ] as const) {
      const length = doc.arrangement.sections.find(
        (section) => section.id === sectionId,
      )?.lengthTicks;
      if (length === undefined) throw new Error("missing section");
      for (const point of entry?.points ?? []) {
        expect(point.tick).toBeGreaterThanOrEqual(0);
        expect(point.tick).toBeLessThanOrEqual(length);
      }
    }
    expectRampsLongEnough(fixture, doc);
  });

  it("merges automation: outside points stay, inside points are replaced", async () => {
    const fixture = await openBrushFixture();
    await fixture.history.load();
    await commitOps(
      fixture,
      [
        {
          op: "automation.set",
          scope: { kind: "lane", sectionId: "sec_001", trackId: "trk_drums" },
          target: "track:trk_drums/gainDb",
          points: [
            { tick: 0, value: 0, curve: "linear" },
            { tick: 1.5 * BAR, value: 5, curve: "linear" },
            { tick: 3 * BAR, value: 0, curve: "linear" },
          ],
        },
      ],
      "Seed gain",
    );

    await commitBrush(fixture, "louder", REGION, 0.5);
    const points =
      automationFor(documentOf(fixture), "sec_001", "trk_drums", "gainDb")?.points ?? [];

    expect(points.some((point) => point.tick === 0 && point.value === 0)).toBe(true);
    expect(points.some((point) => point.tick === 3 * BAR && point.value === 0)).toBe(true);
    expect(points.some((point) => point.tick === 1.5 * BAR)).toBe(false);
    // +12 dB × 0.5 on top of the value at the region start.
    expect(points.find((point) => point.tick === BAR)?.value).toBeGreaterThan(5);
  });

  it("updates the macro fx on a second stroke instead of adding another", async () => {
    const fixture = await openBrushFixture();
    await fixture.history.load();
    await commitBrush(fixture, "space", REGION, 0.6);
    const first = documentOf(fixture);
    const firstFx = first.tracks
      .find((track) => track.id === "trk_drums")
      ?.fx.filter((fx) => fx.macroOwned === "space")
      .map((fx) => fx.id);
    expect(firstFx?.length).toBeGreaterThan(0);

    await commitBrush(fixture, "space", REGION, 0.8);
    const second = documentOf(fixture);
    expect(
      second.tracks
        .find((track) => track.id === "trk_drums")
        ?.fx.filter((fx) => fx.macroOwned === "space")
        .map((fx) => fx.id),
    ).toEqual(firstFx);
    // The target keeps one entry per section lane; the points were replaced, not appended.
    const entries = lane(second, "sec_001", "trk_drums").filter((entry) =>
      entry.target.startsWith("fx:"),
    );
    expect(entries.length).toBeGreaterThan(0);
    expect(new Set(entries.map((entry) => entry.target)).size).toBe(entries.length);
  });

  it("drives the brightness macro to the negative side for Darker", async () => {
    const brightness = MACROS.macros.find((macro) => macro.id === "brightness");
    const highDb = brightness?.drives.find((drive) => drive.param === "highDb");
    if (highDb === undefined) throw new Error("brightness no longer drives eq3 highDb");

    const dark = await openBrushFixture();
    await dark.history.load();
    await commitBrush(dark, "darker", REGION, 0.5);
    const darkPoints =
      automationFor(documentOf(dark), "sec_001", "trk_drums", "highDb")?.points ?? [];

    const bright = await openBrushFixture();
    await bright.history.load();
    await commitBrush(bright, "brighter", REGION, 0.5);
    const brightPoints =
      automationFor(documentOf(bright), "sec_001", "trk_drums", "highDb")?.points ?? [];

    const darkInside = darkPoints.find((point) => point.tick === BAR)?.value ?? 0;
    const brightInside = brightPoints.find((point) => point.tick === BAR)?.value ?? 0;
    expect(brightInside).toBeCloseTo(interpolate(highDb.curve, 0.5), 10);
    expect(darkInside).toBeCloseTo(interpolate(highDb.curve, -0.5), 10);
    expect(darkInside).toBeLessThan(0);
    expect(brightInside).toBeGreaterThan(0);
  });

  it("sweeps the filter up or down with exponential Hz and opens to 20 kHz at the edges", async () => {
    const up = await openBrushFixture();
    await up.history.load();
    await commitBrush(up, "filterSweep", REGION, 0.8, "up");
    const upDoc = documentOf(up);
    const upFilter = upDoc.tracks
      .find((track) => track.id === "trk_drums")
      ?.fx.find((fx) => fx.type === "filter");
    expect(upFilter?.params.mode).toBe(0);
    const upPoints = automationFor(upDoc, "sec_001", "trk_drums", "cutoffHz")?.points ?? [];
    expect(upPoints[0]?.value).toBe(20_000);
    expect(upPoints.find((point) => point.tick === BAR)?.value).toBeLessThan(20_000);
    expect(upPoints.find((point) => point.tick === 2 * BAR)?.value).toBe(20_000);

    const down = await openBrushFixture();
    await down.history.load();
    await commitBrush(down, "filterSweep", REGION, 0.8, "down");
    const downPoints =
      automationFor(documentOf(down), "sec_001", "trk_drums", "cutoffHz")?.points ?? [];
    expect(downPoints.find((point) => point.tick === BAR)?.value).toBe(20_000);
    expect(downPoints.find((point) => point.tick === 2 * BAR)?.value).toBeLessThan(20_000);
    expect(downPoints[downPoints.length - 1]?.value).toBe(20_000);
  });

  it("puts Lo-fi on a track fx with mix automation, not a clip fx", async () => {
    const fixture = await openBrushFixture();
    await fixture.history.load();
    const batch = await commitBrush(fixture, "lofi", REGION, 0.7);
    const added = batch?.ops.find((op) => op.op === "fx.add");
    expect(added?.op).toBe("fx.add");
    if (added?.op !== "fx.add") return;
    expect(added.fx.type).toBe("lofi");
    expect(added.scope).toEqual({ kind: "track", trackId: "trk_drums" });
    expect(added.fx.params.mix).toBe(0);

    const doc = documentOf(fixture);
    const mix = automationFor(doc, "sec_001", "trk_drums", "mix")?.points ?? [];
    expect(mix.find((point) => point.tick === BAR)?.value).toBe(0.7);
    expect(mix[0]?.value).toBe(0);
    // No clip was touched.
    const clip = doc.arrangement.sections[1]?.lanes.trk_drums?.clips[0];
    expect(clip?.fx).toBeUndefined();
  });

  it("clears the region for Remove in one op", async () => {
    const fixture = await openBrushFixture();
    await fixture.history.load();
    const batch = await commitBrush(fixture, "remove", REGION, 1);
    expect(batch?.ops).toEqual([{ op: "region.clear", region: REGION }]);
  });

  it("returns null for an empty region or zero strength", async () => {
    const fixture = await openBrushFixture();
    const doc = documentOf(fixture);
    expect(
      brushBatch(doc, "space", { region: region(BAR, BAR), strength: 0.5 }, fixture.model),
    ).toBeNull();
    expect(brushBatch(doc, "space", { region: REGION, strength: 0 }, fixture.model)).toBeNull();
    expect(
      brushBatch(doc, "space", { region: region(0, BAR, []), strength: 0.5 }, fixture.model),
    ).toBeNull();
  });
});
