import { readdirSync, readFileSync } from "node:fs";

import { type Platform, parseMigrations } from "@bragi/platform";
import { createMemoryPlatform } from "@bragi/platform/testing";
import type { Op, OpBatch, Project } from "@bragi/schemas";
import { describe, expect, it } from "vitest";
import { createHistory, type History } from "../../history/state/history.js";
import { buildDemoProject, fakeAssetHash, SHORT_DEMO } from "../api/demo-song.js";
import type { ModelApi } from "../model/model-api.js";
import {
  duplicateSectionBatch,
  lockSectionBatch,
  meterAt,
  moveSectionBatch,
  removeSectionBatch,
  renameSectionBatch,
  resizeSectionBatch,
  sectionBars,
  setSectionKindBatch,
  splitPoint,
  splitSectionBatch,
} from "../state/section-ops.js";
import { createSongStore, type SongStore } from "../state/song-store.js";
import { loadTestModel } from "./fixtures.js";

const MIGRATIONS_DIR = new URL("../../../../../schemas/sqlite/migrations/", import.meta.url);
const migrations = parseMigrations(
  Object.fromEntries(
    readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => [name, readFileSync(new URL(name, MIGRATIONS_DIR), "utf8")]),
  ),
);

const NOW = new Date("2026-10-20T12:00:00.000Z");
const PROJECT_ID = "SECOPS00000000000000001";
const BAR = 3840;

interface Fixture {
  readonly platform: Platform;
  readonly model: ModelApi;
  readonly store: SongStore;
  readonly history: History;
}

async function openFixture(): Promise<Fixture> {
  const platform = await createMemoryPlatform(migrations);
  const model = await loadTestModel();
  const built = buildDemoProject(SHORT_DEMO, {
    assetFor: (key) => fakeAssetHash(`section-ops:${key}`),
    projectId: PROJECT_ID,
  });
  await platform.localDb.run(
    `INSERT OR IGNORE INTO projects (id, title, created_at, updated_at)
     VALUES (?, ?, ?, ?)`,
    [built.project.id, built.project.meta.title, built.project.meta.createdAt, NOW.toISOString()],
  );
  const store = createSongStore(model);
  store.load(built.project, built.assets);
  const history = createHistory({
    platform,
    songStore: store,
    model,
    projectId: built.project.id,
    now: () => NOW,
  });
  await history.load();
  return { platform, model, store, history };
}

function document(fixture: Fixture): Project {
  const doc = fixture.store.store.getState().doc;
  if (doc === null) throw new Error("no document");
  return doc;
}

function testBatch(id: string, ops: Op[]): OpBatch {
  return {
    id,
    author: { kind: "user" },
    label: "Test batch",
    ops: ops as [Op, ...Op[]],
    createdAt: NOW.toISOString(),
  };
}

function section(doc: Project, id: string) {
  const found = doc.arrangement.sections.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no section ${id}`);
  return found;
}

async function commit(fixture: Fixture, batch: OpBatch | null): Promise<Project> {
  if (batch === null) throw new Error("expected a batch");
  const outcome = await fixture.history.commit(batch);
  if (!outcome.ok) throw new Error(`rejected: ${JSON.stringify(outcome.errors)}`);
  return outcome.doc;
}

/** Commits `batch`, checks the result, then undoes and requires the document to be identical. */
async function commitCheckUndo(
  fixture: Fixture,
  batch: OpBatch | null,
  check: (doc: Project) => void,
): Promise<void> {
  const before = structuredClone(document(fixture));
  const after = await commit(fixture, batch);
  check(after);
  const undone = await fixture.history.undo();
  if (undone === null || !undone.ok) throw new Error("undo failed");
  expect(document(fixture)).toEqual(before);
}

describe("section op batches", () => {
  it("moves a part and smooths both joins it creates, as one batch", async () => {
    const fixture = await openFixture();
    const batch = moveSectionBatch(document(fixture), "sec_003", 1, { smooth: true }, NOW);
    expect(batch?.label).toBe("Move Bridge after Intro");
    expect(batch?.ops.map((op) => op.op)).toEqual([
      "section.move",
      "section.set_transition",
      "section.set_transition",
    ]);
    await commitCheckUndo(fixture, batch, (doc) => {
      expect(doc.arrangement.sections.map((entry) => entry.id)).toEqual([
        "sec_000",
        "sec_003",
        "sec_001",
        "sec_002",
        "sec_004",
      ]);
      expect(section(doc, "sec_003").transitionIn).toEqual({
        kind: "crossfade",
        lengthTicks: BAR / 4,
      });
      // Chorus 2 now follows the Bridge's old position.
      expect(section(doc, "sec_004").transitionIn).toEqual({
        kind: "crossfade",
        lengthTicks: BAR / 4,
      });
    });
  });

  it("leaves existing crossfades alone and does nothing without smoothing", async () => {
    const fixture = await openFixture();
    const crossfade = { kind: "crossfade", lengthTicks: BAR / 4 } as const;
    await commit(
      fixture,
      testBatch("bat_crossfades", [
        { op: "section.set_transition", sectionId: "sec_003", transition: crossfade },
        { op: "section.set_transition", sectionId: "sec_004", transition: crossfade },
      ]),
    );

    const smooth = moveSectionBatch(document(fixture), "sec_003", 1, { smooth: true }, NOW);
    expect(smooth?.ops.filter((op) => op.op === "section.set_transition")).toHaveLength(0);

    const plain = moveSectionBatch(document(fixture), "sec_003", 2, { smooth: false }, NOW);
    expect(plain?.label).toBe("Move Bridge after Verse 1");
    expect(plain?.ops).toHaveLength(1);
  });

  it("returns null when a move would change nothing or is out of range", async () => {
    const fixture = await openFixture();
    const doc = document(fixture);
    expect(moveSectionBatch(doc, "sec_001", 1, { smooth: true }, NOW)).toBeNull();
    expect(moveSectionBatch(doc, "sec_001", -1, { smooth: true }, NOW)).toBeNull();
    expect(moveSectionBatch(doc, "sec_001", 5, { smooth: true }, NOW)).toBeNull();
    expect(moveSectionBatch(doc, "sec_missing", 0, { smooth: true }, NOW)).toBeNull();
  });

  it("duplicates a part at the requested index with a fresh id", async () => {
    const fixture = await openFixture();
    const batch = duplicateSectionBatch(document(fixture), "sec_002", 3, "sec_copy", NOW);
    expect(batch?.label).toBe("Duplicate Chorus 1");
    await commitCheckUndo(fixture, batch, (doc) => {
      expect(doc.arrangement.sections.map((entry) => entry.id)).toEqual([
        "sec_000",
        "sec_001",
        "sec_002",
        "sec_copy",
        "sec_003",
        "sec_004",
      ]);
      const copy = section(doc, "sec_copy");
      expect(copy.derivedFrom).toBe("sec_002");
      expect(copy.lengthTicks).toBe(section(doc, "sec_002").lengthTicks);
    });
  });

  it("removes a part, closes the gap and smooths the new join", async () => {
    const fixture = await openFixture();
    const batch = removeSectionBatch(document(fixture), "sec_003", { smooth: true }, NOW);
    expect(batch?.label).toBe("Remove Bridge");
    expect(batch?.ops.map((op) => op.op)).toEqual(["section.remove", "section.set_transition"]);
    await commitCheckUndo(fixture, batch, (doc) => {
      expect(doc.arrangement.sections.map((entry) => entry.id)).toEqual([
        "sec_000",
        "sec_001",
        "sec_002",
        "sec_004",
      ]);
      expect(section(doc, "sec_004").transitionIn).toEqual({
        kind: "crossfade",
        lengthTicks: BAR / 4,
      });
    });
  });

  it("does not smooth a join into the first part", async () => {
    const fixture = await openFixture();
    const batch = removeSectionBatch(document(fixture), "sec_000", { smooth: true }, NOW);
    expect(batch?.ops).toHaveLength(1);
    await commitCheckUndo(fixture, batch, (doc) => {
      expect(doc.arrangement.sections[0]?.id).toBe("sec_001");
      expect(section(doc, "sec_001").transitionIn.kind).toBe("cut");
    });
  });

  it("renames a part in plain language and rejects empty or unchanged names", async () => {
    const fixture = await openFixture();
    expect(renameSectionBatch(document(fixture), "sec_001", "  ", NOW)).toBeNull();
    expect(renameSectionBatch(document(fixture), "sec_001", "Verse 1", NOW)).toBeNull();
    const batch = renameSectionBatch(document(fixture), "sec_001", "Intro verse", NOW);
    expect(batch?.label).toBe("Rename Verse 1 to Intro verse");
    await commitCheckUndo(fixture, batch, (doc) => {
      expect(section(doc, "sec_001").label).toBe("Intro verse");
    });
  });

  it("changes the type and labels it with the new kind", async () => {
    const fixture = await openFixture();
    expect(setSectionKindBatch(document(fixture), "sec_001", "verse", NOW)).toBeNull();
    const batch = setSectionKindBatch(document(fixture), "sec_001", "chorus", NOW);
    expect(batch?.label).toBe("Change Verse 1 to Chorus");
    await commitCheckUndo(fixture, batch, (doc) => {
      expect(section(doc, "sec_001").kind).toBe("chorus");
    });
  });

  it("locks a part from AI and unlocks it again", async () => {
    const fixture = await openFixture();
    const lock = lockSectionBatch(document(fixture), "sec_002", true, NOW);
    expect(lock?.label).toBe("Lock Chorus 1 from AI");
    await commit(fixture, lock);
    expect(section(document(fixture), "sec_002").locked).toBe(true);
    expect(lockSectionBatch(document(fixture), "sec_002", true, NOW)).toBeNull();

    const unlock = lockSectionBatch(document(fixture), "sec_002", false, NOW);
    expect(unlock?.label).toBe("Unlock Chorus 1");
    await commitCheckUndo(fixture, unlock, (doc) => {
      expect(section(doc, "sec_002").locked).toBe(false);
    });
    // The undo inside the helper restored the locked state.
    expect(section(document(fixture), "sec_002").locked).toBe(true);
  });

  it("resizes in whole bars at the section's meter", async () => {
    const fixture = await openFixture();
    const longer = resizeSectionBatch(document(fixture), "sec_002", 6, "loop", NOW);
    expect(longer?.label).toBe("Make Chorus 1 longer (loop)");
    await commitCheckUndo(fixture, longer, (doc) => {
      expect(section(doc, "sec_002").lengthTicks).toBe(6 * BAR);
      expect(sectionBars(doc, section(doc, "sec_002"))).toBe(6);
    });

    const shorter = resizeSectionBatch(document(fixture), "sec_002", 2, "trim", NOW);
    expect(shorter?.label).toBe("Make Chorus 1 shorter (trim)");
    await commitCheckUndo(fixture, shorter, (doc) => {
      expect(section(doc, "sec_002").lengthTicks).toBe(2 * BAR);
    });

    expect(resizeSectionBatch(document(fixture), "sec_002", 4, "loop", NOW)).toBeNull();
    expect(resizeSectionBatch(document(fixture), "sec_002", 0, "trim", NOW)).toBeNull();
  });

  it("splits at the nearest bar line strictly inside the part", async () => {
    const fixture = await openFixture();
    // Chorus 1 starts after 6 bars and is 4 bars long.
    const start = 6 * BAR;
    const point = splitPoint(document(fixture), "sec_002", start + 1.4 * BAR);
    expect(point).toEqual({ atTick: BAR, bar: 8 });
    const batch = splitSectionBatch(document(fixture), "sec_002", start + 1.4 * BAR, NOW);
    expect(batch?.label).toBe("Split Chorus 1 at bar 8");
    await commitCheckUndo(fixture, batch, (doc) => {
      expect(doc.arrangement.sections).toHaveLength(6);
      expect(section(doc, "sec_002").lengthTicks).toBe(BAR);
      expect(doc.arrangement.sections[3]?.lengthTicks).toBe(3 * BAR);
      expect(doc.arrangement.sections[3]?.label).toBe("Chorus 1");
    });
  });

  it("snaps a playhead near the end to the last bar line inside, never the edge", async () => {
    const fixture = await openFixture();
    const start = 6 * BAR;
    expect(splitPoint(document(fixture), "sec_002", start + 3.9 * BAR)).toEqual({
      atTick: 3 * BAR,
      bar: 10,
    });
    expect(splitPoint(document(fixture), "sec_002", start + 0.2 * BAR)).toEqual({
      atTick: BAR,
      bar: 8,
    });

    // A one-bar part has no bar line strictly inside it.
    const doc = structuredClone(document(fixture));
    const intro = doc.arrangement.sections[0];
    if (intro === undefined) throw new Error("no intro");
    intro.lengthTicks = BAR;
    expect(splitPoint(doc, "sec_000", BAR / 2)).toBeNull();
    expect(splitSectionBatch(doc, "sec_000", BAR / 2, NOW)).toBeNull();
  });

  it("reads meters from the time signatures, not a fixed 4/4", async () => {
    const fixture = await openFixture();
    const doc = structuredClone(document(fixture));
    doc.arrangement.timebase.timeSignatures = [
      { bar: 0, numerator: 4, denominator: 4 },
      { bar: 2, numerator: 3, denominator: 4 },
    ];
    // Bar 2 starts at 2 × 3840 ticks and its bars are 3 beats (2880 ticks).
    expect(meterAt(doc, 2 * BAR)).toEqual({ bar: 2, startTick: 2 * BAR, ticksPerBar: 3 * 960 });
    expect(meterAt(doc, 2 * BAR + 3000)).toEqual({
      bar: 3,
      startTick: 2 * BAR + 2880,
      ticksPerBar: 2880,
    });
  });
});
