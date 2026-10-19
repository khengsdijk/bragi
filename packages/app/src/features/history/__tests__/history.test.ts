import { readdirSync, readFileSync } from "node:fs";

import { type Platform, parseMigrations } from "@bragi/platform";
import { createMemoryPlatform } from "@bragi/platform/testing";
import type { Clip, Op, OpBatch, Project, Region } from "@bragi/schemas";
import { beforeEach, describe, expect, it } from "vitest";
import { loadTestModel } from "../../song/__tests__/fixtures.js";
import { buildDemoProject, fakeAssetHash, SHORT_DEMO } from "../../song/api/demo-song.js";
import type { ModelApi } from "../../song/model/model-api.js";
import { type Commit, createSongStore, type SongStore } from "../../song/state/song-store.js";
import { startGesture } from "../state/gesture.js";
import { createHistory, type History, regionBoundariesAlign } from "../state/history.js";

const MIGRATIONS_DIR = new URL("../../../../../schemas/sqlite/migrations/", import.meta.url);
const migrations = parseMigrations(
  Object.fromEntries(
    readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => [name, readFileSync(new URL(name, MIGRATIONS_DIR), "utf8")]),
  ),
);

const NOW = new Date("2026-10-19T12:00:00.000Z");
const PROJECT_ID = "prj_HISTORYTEST0000000000001";
const BAR = 3840;

let batchCounter = 0;

function batch(ops: Op[], label = "Test batch"): OpBatch {
  batchCounter += 1;
  return {
    id: `bat_${String(batchCounter).padStart(6, "0")}`,
    author: { kind: "user" },
    label,
    ops: ops as [Op, ...Op[]],
    createdAt: NOW.toISOString(),
  };
}

async function memoryPlatform(): Promise<Platform> {
  return createMemoryPlatform(migrations);
}

interface Fixture {
  readonly platform: Platform;
  readonly model: ModelApi;
  readonly store: SongStore;
  readonly history: History;
  readonly built: ReturnType<typeof buildDemoProject>;
}

async function openFixture(platform?: Platform): Promise<Fixture> {
  const actual = platform ?? (await memoryPlatform());
  const model = await loadTestModel();
  const built = buildDemoProject(SHORT_DEMO, {
    assetFor: (key) => fakeAssetHash(`history:${key}`),
    projectId: PROJECT_ID.slice("prj_".length),
  });
  await actual.localDb.run(
    `INSERT OR IGNORE INTO projects (id, title, created_at, updated_at)
     VALUES (?, ?, ?, ?)`,
    [built.project.id, built.project.meta.title, built.project.meta.createdAt, NOW.toISOString()],
  );
  const store = createSongStore(model);
  store.load(built.project, built.assets);
  const history = createHistory({
    platform: actual,
    songStore: store,
    model,
    projectId: built.project.id,
    now: () => NOW,
  });
  return { platform: actual, model, store, history, built };
}

function document(fixture: Fixture): Project {
  const doc = fixture.store.store.getState().doc;
  if (doc === null) throw new Error("no document");
  return doc;
}

describe("history store", () => {
  beforeEach(() => {
    batchCounter = 0;
  });

  it("creates an Imported root for a pre-2.1 project and reloads it", async () => {
    const fixture = await openFixture();
    await fixture.history.load();
    let state = fixture.history.store.getState();
    expect(state.commits.size).toBe(1);
    const root = [...state.commits.values()][0];
    expect(root?.label).toBe("Imported");
    expect(root?.parent).toBeNull();
    expect(root?.authorKind).toBe("system");
    expect(root?.batch.ops).toEqual([]);
    expect(state.head).toBe(root?.id);
    expect(state.canUndo).toBe(false);
    expect(state.canRedo).toBe(false);

    const outcome = await fixture.history.commit(
      batch([{ op: "track.update", trackId: "trk_bass", patch: { mute: true } }], "Mute Bass"),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    state = fixture.history.store.getState();
    expect(state.commits.size).toBe(2);
    expect(state.head).toBe([...state.commits.values()][1]?.id);
    expect(state.canUndo).toBe(true);

    const reopened = await openFixture(fixture.platform);
    await reopened.history.load();
    const again = reopened.history.store.getState();
    expect([...again.commits.keys()]).toEqual([...state.commits.keys()]);
    expect(again.head).toBe(state.head);
    expect(again.commits.get(state.head ?? "")?.label).toBe("Mute Bass");
  });

  it("undoes and redoes a commit, and a new commit clears redo", async () => {
    const fixture = await openFixture();
    await fixture.history.load();
    const before = structuredClone(document(fixture));
    const outcome = await fixture.history.commit(
      batch([{ op: "track.update", trackId: "trk_pads", patch: { gainDb: -2 } }], "Quieter pads"),
    );
    expect(outcome.ok).toBe(true);
    const after = structuredClone(document(fixture));

    const undone = await fixture.history.undo();
    expect(undone?.ok).toBe(true);
    expect(document(fixture)).toEqual(before);
    let state = fixture.history.store.getState();
    expect(state.canUndo).toBe(false);
    expect(state.canRedo).toBe(true);
    // Project open follows HEAD: the row's snapshot pointer moved with undo.
    const head = state.head === null ? undefined : state.commits.get(state.head);
    expect(
      await fixture.platform.localDb.query("SELECT snapshot_hash FROM projects WHERE id = ?", [
        PROJECT_ID,
      ]),
    ).toEqual([{ snapshot_hash: head?.snapshotHash }]);

    const redone = await fixture.history.redo();
    expect(redone?.ok).toBe(true);
    expect(document(fixture)).toEqual(after);
    state = fixture.history.store.getState();
    expect(state.canRedo).toBe(false);

    expect(await fixture.history.undo()).not.toBeNull();
    state = fixture.history.store.getState();
    expect(state.redo).toHaveLength(1);
    const next = await fixture.history.commit(
      batch([{ op: "track.update", trackId: "trk_drums", patch: { mute: true } }], "Mute drums"),
    );
    expect(next.ok).toBe(true);
    state = fixture.history.store.getState();
    expect(state.redo).toEqual([]);
    expect(state.canRedo).toBe(false);
    expect(await fixture.history.redo()).toBeNull();
  });

  it("chains overlapping commits and undos in call order", async () => {
    const fixture = await openFixture();
    await fixture.history.load();
    const root = fixture.history.store.getState().head;
    const [first, second, third] = await Promise.all([
      fixture.history.commit(
        batch([{ op: "track.update", trackId: "trk_bass", patch: { mute: true } }], "Mute Bass"),
      ),
      fixture.history.commit(
        batch([{ op: "track.update", trackId: "trk_pads", patch: { gainDb: -2 } }], "Quieter pads"),
      ),
      fixture.history.undo(),
    ]);
    expect([first.ok, second.ok, third?.ok]).toEqual([true, true, true]);

    const state = fixture.history.store.getState();
    const [bass, pads] = [...state.commits.values()].filter((commit) => commit.parent !== null);
    expect(bass?.parent).toBe(root);
    expect(pads?.parent).toBe(bass?.id);
    // The undo ran last, so HEAD is the first edit and its snapshot holds only that edit.
    expect(state.head).toBe(bass?.id);
    const doc = document(fixture);
    expect(doc.tracks.find((track) => track.id === "trk_bass")?.mute).toBe(true);
    expect(doc.tracks.find((track) => track.id === "trk_pads")?.gainDb).not.toBe(-2);
  });

  it("previews a drag without touching the document and commits it once", async () => {
    const fixture = await openFixture();
    await fixture.history.load();
    const before = structuredClone(document(fixture));
    const ids = before.arrangement.sections.map((section) => section.id);
    const dragged = ids.at(-1) as string;
    const sent: Commit[] = [];
    const gesture = startGesture({
      songStore: fixture.store,
      history: fixture.history,
      engine: (commit) => sent.push(commit),
    });
    if (gesture === null) throw new Error("expected a gesture");

    for (const toIndex of [2, 1, 0]) {
      expect(
        gesture.step(batch([{ op: "section.move", sectionId: dragged, toIndex }], "Move")).ok,
      ).toBe(true);
      // 01 §5: drags never mutate the document; views render the preview.
      expect(document(fixture)).toEqual(before);
      expect(fixture.store.store.getState().preview?.arrangement.sections[toIndex]?.id).toBe(
        dragged,
      );
    }
    expect(sent).toHaveLength(3);
    const previewed = structuredClone(fixture.store.store.getState().preview);

    const outcome = await gesture.commit("Move the outro");
    expect(outcome?.ok).toBe(true);
    expect(fixture.store.store.getState().preview).toBeNull();
    expect(document(fixture)).toEqual(previewed);
    const state = fixture.history.store.getState();
    const head = state.commits.get(state.head ?? "");
    expect(head?.label).toBe("Move the outro");
    expect(head?.batch.ops).toEqual([{ op: "section.move", sectionId: dragged, toIndex: 0 }]);
    expect(sent).toHaveLength(4);

    expect((await fixture.history.undo())?.ok).toBe(true);
    expect(document(fixture)).toEqual(before);
  });

  it("cancels a gesture, and a drag back to the start records nothing", async () => {
    const fixture = await openFixture();
    await fixture.history.load();
    const commits = fixture.history.store.getState().commits.size;
    const ids = document(fixture).arrangement.sections.map((section) => section.id);
    const sent: Commit[] = [];
    const engine = (commit: Commit): void => {
      sent.push(commit);
    };

    const cancelled = startGesture({ songStore: fixture.store, history: fixture.history, engine });
    cancelled?.step(batch([{ op: "section.move", sectionId: ids[0] as string, toIndex: 1 }]));
    cancelled?.cancel();
    expect(fixture.store.store.getState().preview).toBeNull();
    // The engine heard the step and then the way back.
    expect(sent).toHaveLength(2);
    expect(sent[1]?.batch).toBeNull();

    const roundTrip = startGesture({ songStore: fixture.store, history: fixture.history, engine });
    roundTrip?.step(batch([{ op: "section.move", sectionId: ids[0] as string, toIndex: 1 }]));
    roundTrip?.step(batch([{ op: "section.move", sectionId: ids[0] as string, toIndex: 0 }]));
    expect(await roundTrip?.commit("Move")).toBeNull();
    expect(fixture.history.store.getState().commits.size).toBe(commits);
    expect(document(fixture).arrangement.sections.map((section) => section.id)).toEqual(ids);
  });

  it("branches naturally from a non-tip commit", async () => {
    const fixture = await openFixture();
    await fixture.history.load();
    const first = await fixture.history.commit(
      batch([{ op: "project.set_meta", title: "One" }], "One"),
    );
    const second = await fixture.history.commit(
      batch([{ op: "project.set_meta", title: "Two" }], "Two"),
    );
    expect(first.ok && second.ok).toBe(true);
    const state = fixture.history.store.getState();
    const firstId = [...state.commits.values()][1]?.id;
    const secondId = state.head;

    const checkedOut = await fixture.history.checkout(firstId ?? "");
    expect(checkedOut?.ok).toBe(true);
    expect(document(fixture).meta.title).toBe("One");
    expect(fixture.history.store.getState().canRedo).toBe(false);

    const branch = await fixture.history.commit(
      batch([{ op: "project.set_meta", title: "Side" }], "Side"),
    );
    expect(branch.ok).toBe(true);
    const after = fixture.history.store.getState();
    const sideId = after.head;
    expect(after.commits.get(sideId ?? "")?.parent).toBe(firstId);
    expect(after.children.get(firstId ?? "")).toEqual([secondId, sideId]);
  });

  it("names, renames and deletes branches and stars commits", async () => {
    const fixture = await openFixture();
    await fixture.history.load();
    await fixture.history.commit(batch([{ op: "project.set_meta", title: "Club" }], "Club cut"));
    const state = fixture.history.store.getState();
    const head = state.head ?? "";

    await fixture.history.nameBranch("  Club  ");
    expect(fixture.history.store.getState().branches.get("Club")).toBe(head);
    await fixture.history.renameBranch("Club", "Live");
    expect(fixture.history.store.getState().branches.get("Club")).toBeUndefined();
    expect(fixture.history.store.getState().branches.get("Live")).toBe(head);

    await fixture.history.star(head);
    expect(fixture.history.store.getState().starred.has(head)).toBe(true);
    await fixture.history.unstar(head);
    expect(fixture.history.store.getState().starred.has(head)).toBe(false);

    await fixture.history.star(head);
    const reopened = await openFixture(fixture.platform);
    await reopened.history.load();
    const reloaded = reopened.history.store.getState();
    expect(reloaded.branches.get("Live")).toBe(head);
    expect(reloaded.starred.has(head)).toBe(true);

    await reopened.history.deleteBranch("Live");
    expect(reopened.history.store.getState().branches.has("Live")).toBe(false);
    const third = await openFixture(fixture.platform);
    await third.history.load();
    expect(third.history.store.getState().branches.has("Live")).toBe(false);
  });

  it("adds candidates, accepts one and discards the rest", async () => {
    const fixture = await openFixture();
    await fixture.history.load();
    const base = await fixture.history.commit(
      batch([{ op: "project.set_meta", title: "Base" }], "Base"),
    );
    expect(base.ok).toBe(true);
    const headBefore = fixture.history.store.getState().head;

    const candidates = await fixture.history.addCandidates(
      [
        batch([{ op: "track.update", trackId: "trk_bass", patch: { gainDb: -3 } }], "Cand A"),
        batch([{ op: "track.update", trackId: "trk_bass", patch: { gainDb: 3 } }], "Cand B"),
      ],
      "grp_one",
    );
    expect(candidates).toHaveLength(2);
    let state = fixture.history.store.getState();
    expect(state.head).toBe(headBefore);
    expect(state.children.get(headBefore ?? "")).toEqual(
      expect.arrayContaining(candidates.map((candidate) => candidate.id)),
    );
    expect(candidates.every((candidate) => candidate.state === "candidate")).toBe(true);
    expect(candidates.every((candidate) => candidate.candidateGroup === "grp_one")).toBe(true);

    const accepted = await fixture.history.accept(candidates[0]?.id ?? "");
    expect(accepted?.ok).toBe(true);
    state = fixture.history.store.getState();
    expect(state.head).toBe(candidates[0]?.id);
    expect(state.commits.get(candidates[0]?.id ?? "")?.state).toBe("committed");
    expect(state.commits.get(candidates[1]?.id ?? "")?.state).toBe("discarded");
    expect(document(fixture).tracks.find((track) => track.id === "trk_bass")?.gainDb).toBe(-3);

    const group = await fixture.history.addCandidates(
      [batch([{ op: "track.update", trackId: "trk_drums", patch: { mute: true } }], "Cand C")],
      "grp_two",
    );
    await fixture.history.discardGroup("grp_two");
    state = fixture.history.store.getState();
    expect(state.commits.get(group[0]?.id ?? "")?.state).toBe("discarded");
    expect(state.head).toBe(candidates[0]?.id);
  });

  it("adopts a region from an earlier commit and frees its temporary handle", async () => {
    const fixture = await openFixture();
    await fixture.history.load();

    const source = await fixture.history.commit(
      batch([{ op: "clip.update", clipId: "clp_s0xpads", patch: { gainDb: -6 } }], "Quiet pads"),
    );
    expect(source.ok).toBe(true);
    const sourceState = fixture.history.store.getState();
    const sourceCommit = [...sourceState.commits.values()].at(-1);
    if (sourceCommit === undefined) throw new Error("no source commit");

    const rival = await fixture.history.commit(
      batch([{ op: "clip.update", clipId: "clp_s0xpads", patch: { gainDb: 0 } }]),
    );
    expect(rival.ok).toBe(true);
    const handleCount = fixture.model.docCount();

    const adopted = await fixture.history.adoptRegion(
      { startTick: 0, endTick: 2 * BAR, tracks: ["trk_pads"] },
      sourceCommit.id,
    );
    expect(adopted.ok).toBe(true);
    expect(fixture.model.docCount()).toBe(handleCount);
    const pads = document(fixture).arrangement.sections[0]?.lanes.trk_pads;
    expect(pads?.clips.some((clip) => clip.gainDb === -6)).toBe(true);

    const undone = await fixture.history.undo();
    expect(undone?.ok).toBe(true);
    const restored = document(fixture).arrangement.sections[0]?.lanes.trk_pads;
    expect(restored?.clips.every((clip) => clip.gainDb === 0)).toBe(true);
  });

  it("writes nothing for a rejected batch", async () => {
    const fixture = await openFixture();
    await fixture.history.load();
    const before = fixture.history.store.getState();
    const outboxBefore = await fixture.platform.localDb.query("SELECT commit_id FROM outbox");
    const projectBefore = await fixture.platform.localDb.query(
      "SELECT snapshot_hash FROM projects WHERE id = ?",
      [PROJECT_ID],
    );
    const outcome = await fixture.history.commit(
      batch([{ op: "track.update", trackId: "trk_missing", patch: { mute: true } }], "Bad"),
    );
    expect(outcome.ok).toBe(false);
    const after = fixture.history.store.getState();
    expect(after.commits.size).toBe(before.commits.size);
    expect(after.head).toBe(before.head);
    expect(await fixture.platform.localDb.query("SELECT commit_id FROM outbox")).toEqual(
      outboxBefore,
    );
    expect(
      await fixture.platform.localDb.query("SELECT snapshot_hash FROM projects WHERE id = ?", [
        PROJECT_ID,
      ]),
    ).toEqual(projectBefore);
  });

  it("rejects a region.adopt from an unknown commit without writing", async () => {
    const fixture = await openFixture();
    await fixture.history.load();
    const before = fixture.history.store.getState().commits.size;
    const outcome = await fixture.history.commit(
      batch([
        {
          op: "region.adopt",
          fromCommit: "cmt_missing",
          region: { startTick: 0, endTick: BAR, tracks: "all" },
        },
      ]),
    );
    expect(outcome.ok).toBe(false);
    expect(fixture.history.store.getState().commits.size).toBe(before);
  });

  it("reports whether region boundaries line up", async () => {
    const fixture = await openFixture();
    const root = structuredClone(document(fixture));
    const region: Region = { startTick: 0, endTick: 2 * BAR, tracks: "all" };
    expect(regionBoundariesAlign(fixture.model, root, root, region)).toBe(true);

    await fixture.history.load();
    const resized = await fixture.history.commit(
      batch(
        [{ op: "section.resize", sectionId: "sec_000", lengthTicks: 1000, mode: "trim" }],
        "Trim intro",
      ),
    );
    expect(resized.ok).toBe(true);
    const after = document(fixture);
    expect(regionBoundariesAlign(fixture.model, root, after, region)).toBe(false);
  });
});

/**
 * One case per op kind (02 §4.2). Each commits the batch, undoes it and asserts
 * the document is deep-equal to before, then redoes and asserts it is deep-equal
 * to after. `analysis.apply` is not here: it is a system/flow op that needs an
 * analysis blob and effects, not a user edit; `flow.test.ts` covers it.
 */
describe("undo restores the document for every op kind", () => {
  beforeEach(() => {
    batchCounter = 0;
  });

  type MakeBatch = (doc: Project, fixture: Fixture) => OpBatch;
  type Setup = (fixture: Fixture) => Promise<void>;

  async function expectUndoable(name: string, make: MakeBatch, setup?: Setup): Promise<void> {
    const fixture = await openFixture();
    await fixture.history.load();
    if (setup) await setup(fixture);
    const before = structuredClone(document(fixture));
    const outcome = await fixture.history.commit(make(before, fixture));
    expect(outcome.ok, `${name}: ${outcome.ok ? "applied" : JSON.stringify(outcome.errors)}`).toBe(
      true,
    );
    if (!outcome.ok) return;
    const after = structuredClone(document(fixture));

    const undone = await fixture.history.undo();
    expect(undone?.ok).toBe(true);
    expect(document(fixture)).toEqual(before);

    const redone = await fixture.history.redo();
    expect(redone?.ok).toBe(true);
    expect(document(fixture)).toEqual(after);
  }

  const clip = (id: string, asset: string, ticks = 1920): Clip => ({
    id,
    asset,
    srcStart: 0,
    srcEnd: 48_000,
    start: 0,
    warp: {
      mode: "beatgrid",
      anchors: [
        { srcSample: 0, tick: 0 },
        { srcSample: 48_000, tick: ticks },
      ],
    },
    gainDb: 0,
    pitchSemitones: 0,
    fadeInTicks: 0,
    fadeOutTicks: 0,
    fadeCurve: "equal_power",
    provenance: { kind: "user", createdAt: NOW.toISOString() },
  });

  it("project.set_meta", () =>
    expectUndoable("project.set_meta", () =>
      batch([{ op: "project.set_meta", title: "Renamed", tags: ["x"] }]),
    ));

  it("track.add", () =>
    expectUndoable("track.add", () =>
      batch([
        {
          op: "track.add",
          index: 0,
          track: {
            id: "trk_new",
            name: "Strings",
            role: "strings",
            color: "#8A8F98",
            gainDb: 0,
            pan: 0,
            mute: false,
            solo: false,
            hidden: false,
            fx: [],
          },
        },
      ]),
    ));

  it("track.update", () =>
    expectUndoable("track.update", () =>
      batch([{ op: "track.update", trackId: "trk_bass", patch: { gainDb: -4.5 } }]),
    ));

  it("track.remove", () =>
    expectUndoable("track.remove", () => batch([{ op: "track.remove", trackId: "trk_arp" }])));

  it("fx.add", () =>
    expectUndoable("fx.add", () =>
      batch([
        {
          op: "fx.add",
          scope: { kind: "track", trackId: "trk_bass" },
          fx: { id: "fx_one", type: "eq3", params: { lowDb: 0 }, bypass: false },
        },
      ]),
    ));

  it("fx.update", async () => {
    const setup: Setup = async (fixture) => {
      await fixture.history.commit(
        batch([
          {
            op: "fx.add",
            scope: { kind: "track", trackId: "trk_bass" },
            fx: { id: "fx_one", type: "eq3", params: { lowDb: 0 }, bypass: false },
          },
        ]),
      );
    };
    await expectUndoable(
      "fx.update",
      () =>
        batch([
          {
            op: "fx.update",
            fxId: "fx_one",
            paramsPatch: { lowDb: 3 },
            bypass: true,
          },
        ]),
      setup,
    );
  });

  it("fx.remove", async () => {
    const setup: Setup = async (fixture) => {
      await fixture.history.commit(
        batch([
          {
            op: "fx.add",
            scope: { kind: "track", trackId: "trk_bass" },
            fx: { id: "fx_one", type: "eq3", params: { lowDb: 0 }, bypass: false },
          },
        ]),
      );
    };
    await expectUndoable("fx.remove", () => batch([{ op: "fx.remove", fxId: "fx_one" }]), setup);
  });

  it("fx.reorder", async () => {
    const setup: Setup = async (fixture) => {
      await fixture.history.commit(
        batch([
          {
            op: "fx.add",
            scope: { kind: "track", trackId: "trk_bass" },
            fx: { id: "fx_one", type: "eq3", params: { lowDb: 0 }, bypass: false },
          },
          {
            op: "fx.add",
            scope: { kind: "track", trackId: "trk_bass" },
            fx: { id: "fx_two", type: "gain", params: { db: 0 }, bypass: false },
          },
        ]),
      );
    };
    await expectUndoable(
      "fx.reorder",
      () => batch([{ op: "fx.reorder", fxId: "fx_two", newIndex: 0 }]),
      setup,
    );
  });

  it("section.insert", () =>
    expectUndoable("section.insert", () =>
      batch([
        {
          op: "section.insert",
          index: 1,
          section: {
            id: "sec_new",
            kind: "custom",
            label: "New",
            lengthTicks: BAR,
            lanes: {},
            transitionIn: { kind: "cut", lengthTicks: 0 },
          },
        },
      ]),
    ));

  it("section.remove", () =>
    expectUndoable("section.remove", () =>
      batch([{ op: "section.remove", sectionId: "sec_003", closeGap: true }]),
    ));

  it("section.move", () =>
    expectUndoable("section.move", () =>
      batch([{ op: "section.move", sectionId: "sec_000", toIndex: 2 }]),
    ));

  it("section.duplicate", () =>
    expectUndoable("section.duplicate", () =>
      batch([{ op: "section.duplicate", sectionId: "sec_000", toIndex: 5, newId: "sec_dup" }]),
    ));

  it("section.resize", () =>
    expectUndoable("section.resize", () =>
      batch([{ op: "section.resize", sectionId: "sec_000", lengthTicks: 1000, mode: "trim" }]),
    ));

  it("section.split", () =>
    expectUndoable("section.split", () =>
      batch([{ op: "section.split", sectionId: "sec_001", atTick: 1920, newId: "sec_split" }]),
    ));

  it("section.merge", () =>
    expectUndoable("section.merge", () =>
      batch([{ op: "section.merge", sectionIdA: "sec_001", sectionIdB: "sec_002" }]),
    ));

  it("section.update", () =>
    expectUndoable("section.update", () =>
      batch([{ op: "section.update", sectionId: "sec_000", patch: { label: "Opening" } }]),
    ));

  it("section.set_transition", () =>
    expectUndoable("section.set_transition", () =>
      batch([
        {
          op: "section.set_transition",
          sectionId: "sec_001",
          transition: { kind: "crossfade", lengthTicks: 960 },
        },
      ]),
    ));

  it("clip.add", () =>
    expectUndoable("clip.add", (_doc, fixture) =>
      batch([
        {
          op: "clip.add",
          sectionId: "sec_000",
          trackId: "trk_drums",
          clip: clip("clp_added", fixture.built.assets[0]?.hash ?? fakeAssetHash("add")),
        },
      ]),
    ));

  it("clip.update", () =>
    expectUndoable("clip.update", () =>
      batch([{ op: "clip.update", clipId: "clp_s0xpads", patch: { gainDb: -3 } }]),
    ));

  it("clip.remove", () =>
    expectUndoable("clip.remove", () => batch([{ op: "clip.remove", clipId: "clp_s0xpads" }])));

  it("clip.replace", () =>
    expectUndoable("clip.replace", (_doc, fixture) =>
      batch([
        {
          op: "clip.replace",
          clipId: "clp_s0xpads",
          clips: [clip("clp_r1", fixture.built.assets[0]?.hash ?? fakeAssetHash("r1"))],
        },
      ]),
    ));

  it("clip.split", () =>
    expectUndoable("clip.split", () =>
      batch([{ op: "clip.split", clipId: "clp_s0xpads", atTick: 1920, newId: "clp_second" }]),
    ));

  it("automation.set", () =>
    expectUndoable("automation.set", () =>
      batch([
        {
          op: "automation.set",
          scope: { kind: "lane", sectionId: "sec_000", trackId: "trk_pads" },
          target: "track:trk_pads/gainDb",
          points: [
            { tick: 0, value: 0, curve: "step" },
            { tick: 960, value: 1, curve: "linear" },
          ],
        },
      ]),
    ));

  it("automation.clear", async () => {
    const setup: Setup = async (fixture) => {
      await fixture.history.commit(
        batch([
          {
            op: "automation.set",
            scope: { kind: "lane", sectionId: "sec_000", trackId: "trk_pads" },
            target: "track:trk_pads/gainDb",
            points: [
              { tick: 0, value: 0, curve: "step" },
              { tick: 960, value: 1, curve: "linear" },
            ],
          },
        ]),
      );
    };
    await expectUndoable(
      "automation.clear",
      () =>
        batch([
          {
            op: "automation.clear",
            scope: { kind: "lane", sectionId: "sec_000", trackId: "trk_pads" },
            target: "track:trk_pads/gainDb",
          },
        ]),
      setup,
    );
  });

  it("tempo.set", () =>
    expectUndoable("tempo.set", () =>
      batch([
        {
          op: "tempo.set",
          tempoMap: [
            { tick: 0, bpm: 90, curve: "step" },
            { tick: BAR, bpm: 140, curve: "linear" },
          ],
        },
      ]),
    ));

  it("key.transpose", () =>
    expectUndoable("key.transpose", () =>
      batch([{ op: "key.transpose", semitones: 2, scope: "all" }]),
    ));

  it("region.clear", () =>
    expectUndoable("region.clear", () =>
      batch([
        {
          op: "region.clear",
          region: { startTick: 960, endTick: 2880, tracks: "all" },
        },
      ]),
    ));

  it("region.adopt", async () => {
    let sourceId = "";
    const setup: Setup = async (fixture) => {
      const source = await fixture.history.commit(
        batch([{ op: "clip.update", clipId: "clp_s0xpads", patch: { gainDb: -6 } }]),
      );
      if (!source.ok) throw new Error(JSON.stringify(source.errors));
      sourceId = fixture.history.store.getState().head ?? "";
      // Move away from the source commit, then adopt from it.
      const away = await fixture.history.commit(
        batch([{ op: "clip.update", clipId: "clp_s0xpads", patch: { gainDb: 0 } }]),
      );
      if (!away.ok) throw new Error(JSON.stringify(away.errors));
    };
    await expectUndoable(
      "region.adopt",
      () =>
        batch([
          {
            op: "region.adopt",
            fromCommit: sourceId,
            region: { startTick: 0, endTick: 2 * BAR, tracks: ["trk_pads"] },
          },
        ]),
      setup,
    );
  });
});
