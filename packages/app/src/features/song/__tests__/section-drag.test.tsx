// @vitest-environment jsdom
/**
 * Canvas drags (07 §4.1–4.2, 10 check 1): reorder with a live preview, Alt-duplicate, Escape and
 * the right-edge resize. The real `bragi-model` and history store run underneath, so "the
 * document did not change until release" and "undo is deep-equal" are claims about the shipped
 * op application, not mocks.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Platform, parseMigrations } from "@bragi/platform";
import { createMemoryPlatform } from "@bragi/platform/testing";
import type { Project, SectionResizeMode } from "@bragi/schemas";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useMemo } from "react";
import { describe, expect, it, type Mock, vi } from "vitest";

import { createHistory, type History } from "../../history/state/history.js";
import { createSettingsStore } from "../../settings/state/settings-store.js";
import { buildDemoProject, fakeAssetHash, SHORT_DEMO } from "../api/demo-song.js";
import { buildCanvasDocument } from "../api/view-model.js";
import { useSectionDrag } from "../hooks/use-section-drag.js";
import { useSongActions } from "../hooks/use-song-actions.js";
import { createEngineController, type EngineController } from "../state/engine-controller.js";
import type { Commit, SongStore } from "../state/song-store.js";
import { createSongStore } from "../state/song-store.js";
import { loadTestModel } from "./fixtures.js";

// `import.meta.url` is not a file URL under jsdom, so resolve from this file's directory.
const MIGRATIONS_DIR = resolve(import.meta.dirname, "../../../../../schemas/sqlite/migrations");
const migrations = parseMigrations(
  Object.fromEntries(
    readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => [name, readFileSync(resolve(MIGRATIONS_DIR, name), "utf8")]),
  ),
);

const NOW = new Date("2026-10-20T12:00:00.000Z");
const PROJECT_ID = "SECDRAG0000000000000001";

interface Fixture {
  readonly store: SongStore;
  readonly history: History;
  readonly controller: EngineController;
  readonly engineCalls: { readonly commit: Commit; readonly doc: Project }[];
  readonly announce: Mock<(message: string) => void>;
}

async function openFixture(): Promise<Fixture> {
  const platform: Platform = await createMemoryPlatform(migrations);
  const model = await loadTestModel();
  const built = buildDemoProject(SHORT_DEMO, {
    assetFor: (key) => fakeAssetHash(`section-drag:${key}`),
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

  const engineCalls: { commit: Commit; doc: Project }[] = [];
  const base = createEngineController({
    document: () => store.store.getState().doc,
    durationSec: () => 32,
  });
  const controller: EngineController = {
    ...base,
    commit(commit, doc) {
      engineCalls.push({ commit, doc });
      base.commit(commit, doc);
    },
  };
  return {
    store,
    history,
    controller,
    engineCalls,
    announce: vi.fn<(message: string) => void>(),
  };
}

function useHarness(
  fixture: Fixture,
  onResize?: (id: string, bars: number, mode: SectionResizeMode) => void,
) {
  const settings = useMemo(() => createSettingsStore(), []);
  const actions = useSongActions({
    songStore: fixture.store,
    controller: fixture.controller,
    settings,
    history: fixture.history,
    model: fixture.store.model,
    selection: { kind: "sections", ids: ["sec_000"] },
    focus: null,
    historyOpen: false,
    onToggleHistory: () => {},
    onAnnounce: fixture.announce,
  });
  const drag = useSectionDrag({
    songStore: fixture.store,
    controller: fixture.controller,
    settings,
    history: fixture.history,
    onAnnounce: fixture.announce,
    onResize:
      onResize ??
      ((id, bars, mode) => {
        actions.resize(id, bars, mode);
      }),
  });
  return { actions, drag };
}

function ids(project: Project | null): string[] {
  return project?.arrangement.sections.map((section) => section.id) ?? [];
}

function live(fixture: Fixture): Project {
  const doc = fixture.store.store.getState().doc;
  if (doc === null) throw new Error("no document");
  return doc;
}

function preview(fixture: Fixture): Project | null {
  return fixture.store.store.getState().preview;
}

function committedBatches(fixture: Fixture) {
  const state = fixture.history.store.getState();
  return [...state.commits.values()].map((commit) => commit.batch);
}

describe("section drags", () => {
  it("previews three reorder steps and commits one section.move plus its smart joins", async () => {
    const fixture = await openFixture();
    const before = structuredClone(live(fixture));
    const original = ids(before);
    const startHead = fixture.history.store.getState().head;
    const { result } = renderHook(() => useHarness(fixture));

    act(() => {
      result.current.drag.onSectionDragStart({
        sectionId: "sec_000",
        pointerX: 100,
        dropIndex: 0,
        altKey: false,
      });
    });
    expect(live(fixture).arrangement.sections.map((entry) => entry.id)).toEqual(original);
    expect(preview(fixture)).toBeNull();

    for (const slot of [2, 3, 4]) {
      act(() => {
        result.current.drag.onSectionDragMove({
          sectionId: "sec_000",
          pointerX: 100 + slot * 10,
          dropIndex: slot,
          altKey: false,
        });
      });
      // The live document never moves during the drag.
      expect(ids(live(fixture))).toEqual(original);
    }
    expect(ids(preview(fixture))).toEqual(["sec_001", "sec_002", "sec_003", "sec_000", "sec_004"]);

    // The canvas and the accessible grid read the preview: its own handle gives the new spans.
    const previewDoc = preview(fixture);
    const previewHandle = fixture.store.previewHandle();
    expect(previewDoc).not.toBeNull();
    expect(previewHandle).not.toBeNull();
    if (previewDoc !== null && previewHandle !== null) {
      const view = buildCanvasDocument(fixture.store.model, previewHandle, previewDoc);
      expect(view.sections.map((section) => section.id)).toEqual([
        "sec_001",
        "sec_002",
        "sec_003",
        "sec_000",
        "sec_004",
      ]);
      expect(view.sections.find((section) => section.id === "sec_000")).toMatchObject({
        startSec: 20,
        endSec: 24,
      });
    }

    act(() => {
      result.current.drag.onSectionDragEnd({
        sectionId: "sec_000",
        pointerX: 140,
        dropIndex: 4,
        altKey: false,
      });
    });
    await waitFor(() => expect(fixture.history.store.getState().head).not.toBe(startHead));
    expect(preview(fixture)).toBeNull();
    expect(fixture.store.previewHandle()).toBeNull();

    expect(ids(live(fixture))).toEqual(["sec_001", "sec_002", "sec_003", "sec_000", "sec_004"]);
    const batches = committedBatches(fixture);
    const batch = batches.at(-1);
    expect(batch?.label).toBe("Move Intro after Bridge");
    expect(batch?.ops.map((op) => op.op)).toEqual(["section.move", "section.set_transition"]);
    expect(batch?.ops[0]).toEqual({ op: "section.move", sectionId: "sec_000", toIndex: 3 });
    expect(batch?.ops[1]).toEqual({
      op: "section.set_transition",
      sectionId: "sec_000",
      transition: { kind: "crossfade", lengthTicks: 960 },
    });
    expect(fixture.announce).toHaveBeenCalledWith("Move Intro after Bridge");

    const undone = await fixture.history.undo();
    expect(undone?.ok).toBe(true);
    expect(live(fixture)).toEqual(before);
  });

  it("does not commit when the drag returns to its starting slot", async () => {
    const fixture = await openFixture();
    const before = structuredClone(live(fixture));
    const head = fixture.history.store.getState().head;
    const { result } = renderHook(() => useHarness(fixture));

    act(() => {
      result.current.drag.onSectionDragStart({
        sectionId: "sec_000",
        pointerX: 100,
        dropIndex: 0,
        altKey: false,
      });
      result.current.drag.onSectionDragMove({
        sectionId: "sec_000",
        pointerX: 200,
        dropIndex: 3,
        altKey: false,
      });
    });
    expect(preview(fixture)).not.toBeNull();

    act(() => {
      result.current.drag.onSectionDragEnd({
        sectionId: "sec_000",
        pointerX: 90,
        dropIndex: 0,
        altKey: false,
      });
    });
    await waitFor(() => expect(preview(fixture)).toBeNull());
    expect(fixture.history.store.getState().head).toBe(head);
    expect(live(fixture)).toEqual(before);
  });

  it("cancels with Escape: no commit and the engine is sent back", async () => {
    const fixture = await openFixture();
    const before = structuredClone(live(fixture));
    const head = fixture.history.store.getState().head;
    const { result } = renderHook(() => useHarness(fixture));

    act(() => {
      result.current.drag.onSectionDragStart({
        sectionId: "sec_000",
        pointerX: 100,
        dropIndex: 0,
        altKey: false,
      });
      result.current.drag.onSectionDragMove({
        sectionId: "sec_000",
        pointerX: 220,
        dropIndex: 3,
        altKey: false,
      });
    });
    expect(preview(fixture)).not.toBeNull();

    act(() => {
      result.current.drag.onSectionDragCancel({ sectionId: "sec_000" });
    });
    expect(preview(fixture)).toBeNull();
    expect(fixture.history.store.getState().head).toBe(head);
    expect(live(fixture)).toEqual(before);
    const last = fixture.engineCalls.at(-1);
    expect(last?.commit.batch).toBeNull();
    expect(last?.doc).toEqual(before);
  });

  it("Alt-drag duplicates once at the drop slot and commits duplicate plus move", async () => {
    const fixture = await openFixture();
    const before = structuredClone(live(fixture));
    const startHead = fixture.history.store.getState().head;
    const { result } = renderHook(() => useHarness(fixture));

    act(() => {
      result.current.drag.onSectionDragStart({
        sectionId: "sec_000",
        pointerX: 100,
        dropIndex: 1,
        altKey: true,
      });
    });
    const copyId = preview(fixture)?.arrangement.sections[1]?.id;
    expect(copyId).toBeDefined();
    expect(copyId).not.toBe("sec_000");
    expect(ids(preview(fixture))).toEqual([
      "sec_000",
      copyId,
      "sec_001",
      "sec_002",
      "sec_003",
      "sec_004",
    ]);

    act(() => {
      result.current.drag.onSectionDragMove({
        sectionId: "sec_000",
        pointerX: 260,
        dropIndex: 3,
        altKey: true,
      });
      result.current.drag.onSectionDragEnd({
        sectionId: "sec_000",
        pointerX: 260,
        dropIndex: 3,
        altKey: true,
      });
    });
    await waitFor(() => expect(fixture.history.store.getState().head).not.toBe(startHead));
    expect(preview(fixture)).toBeNull();

    expect(ids(live(fixture))).toEqual([
      "sec_000",
      "sec_001",
      "sec_002",
      copyId,
      "sec_003",
      "sec_004",
    ]);
    const batch = committedBatches(fixture).at(-1);
    expect(batch?.label).toBe("Duplicate Intro");
    expect(batch?.ops.map((op) => op.op)).toEqual(["section.duplicate", "section.move"]);
    expect(batch?.ops[0]).toMatchObject({ op: "section.duplicate", sectionId: "sec_000" });
    expect(batch?.ops[1]).toMatchObject({ op: "section.move", sectionId: copyId, toIndex: 3 });
    expect(fixture.announce).toHaveBeenCalledWith("Duplicate Intro");

    await fixture.history.undo();
    expect(live(fixture)).toEqual(before);
  });

  it("offers Loop after a right-edge drag and commits one section.resize", async () => {
    const fixture = await openFixture();
    const before = structuredClone(live(fixture));
    const head = fixture.history.store.getState().head;
    const { result } = renderHook(() => useHarness(fixture));

    act(() => {
      result.current.drag.onSectionResizeStart({
        sectionId: "sec_002",
        pointerX: 200,
        bars: 4,
        clientX: 300,
        clientY: 200,
      });
      result.current.drag.onSectionResizeMove({
        sectionId: "sec_002",
        pointerX: 240,
        bars: 6,
        clientX: 340,
        clientY: 200,
      });
    });
    // A resize is a ghost: no preview and no document change.
    expect(preview(fixture)).toBeNull();
    expect(live(fixture)).toEqual(before);

    act(() => {
      result.current.drag.onSectionResizeEnd({
        sectionId: "sec_002",
        pointerX: 240,
        bars: 6,
        clientX: 340,
        clientY: 200,
      });
    });
    expect(result.current.drag.resizePrompt).toMatchObject({
      sectionId: "sec_002",
      bars: 6,
      currentBars: 4,
    });

    act(() => {
      result.current.drag.chooseResizeMode("loop");
    });
    expect(result.current.drag.resizePrompt).toBeNull();
    await waitFor(() => expect(fixture.history.store.getState().head).not.toBe(head));

    const resized = live(fixture).arrangement.sections.find((entry) => entry.id === "sec_002");
    expect(resized?.lengthTicks).toBe(6 * 3840);
    const batch = committedBatches(fixture).at(-1);
    expect(batch?.ops).toEqual([
      { op: "section.resize", sectionId: "sec_002", lengthTicks: 6 * 3840, mode: "loop" },
    ]);
  });

  it("opens no popover when the resize ends at the same length", async () => {
    const fixture = await openFixture();
    const { result } = renderHook(() => useHarness(fixture));

    act(() => {
      result.current.drag.onSectionResizeStart({
        sectionId: "sec_002",
        pointerX: 200,
        bars: 4,
        clientX: 300,
        clientY: 200,
      });
      result.current.drag.onSectionResizeEnd({
        sectionId: "sec_002",
        pointerX: 202,
        bars: 4,
        clientX: 302,
        clientY: 200,
      });
    });
    expect(result.current.drag.resizePrompt).toBeNull();
    expect(preview(fixture)).toBeNull();
  });
});
