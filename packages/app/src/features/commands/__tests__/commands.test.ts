import type { SectionInstance } from "@bragi/schemas";
import { describe, expect, it, vi } from "vitest";

import { paletteItems } from "../components/CommandPaletteDialog.js";
import {
  type Command,
  type CommandActions,
  type CommandContext,
  createCommandRegistry,
} from "../state/commands.js";
import { EXTEND_COMMANDS, SONG_COMMANDS } from "../state/song-commands.js";

const SECTION: SectionInstance = {
  id: "sec_001",
  kind: "verse",
  label: "Verse 1",
  lengthTicks: 15_360,
  lanes: {},
  transitionIn: { kind: "cut", lengthTicks: 0 },
};

function actions(): CommandActions {
  return {
    moveSection: vi.fn(),
    duplicateSection: vi.fn(),
    removeSection: vi.fn(),
    openRename: vi.fn(),
    openKind: vi.fn(),
    setLocked: vi.fn(),
    loopSection: vi.fn(),
    openResize: vi.fn(),
    openExtend: vi.fn(),
    fillGap: vi.fn(),
    smoothTransition: vi.fn(),
    openBrush: vi.fn(),
    splitAtPlayhead: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    toggleHistory: vi.fn(),
    togglePlay: vi.fn(),
    askAi: vi.fn(),
    toggleExplain: vi.fn(),
  };
}

function context(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    section: SECTION,
    sectionIndex: 1,
    sectionCount: 5,
    sectionBars: 4,
    smartTransitions: true,
    canUndo: true,
    canRedo: false,
    hasHistory: true,
    historyOpen: false,
    playing: false,
    explainMode: false,
    fillGapLabel: null,
    smoothTargetIds: [],
    actions: actions(),
    ...overrides,
  };
}

function command(id: string): Command {
  const found = SONG_COMMANDS.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no command ${id}`);
  return found;
}

function testCommand(id: string): Command {
  return {
    id,
    label: "commands.section.duplicate",
    group: "section",
    enabled: () => true,
    run: () => {},
  };
}

describe("command registry", () => {
  it("lists in registration order, replaces by id and unregisters only its own entry", () => {
    const registry = createCommandRegistry([testCommand("a"), testCommand("b")]);
    expect(registry.list().map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(registry.get("a")?.id).toBe("a");

    const removeB = registry.register(testCommand("b"));
    const replacement = testCommand("b");
    const removeReplacement = registry.register(replacement);
    expect(registry.get("b")).toBe(replacement);
    removeB(); // The older registration must not remove the newest.
    expect(registry.get("b")).toBe(replacement);
    removeReplacement();
    expect(registry.get("b")).toBeUndefined();

    expect(registry.list().map((entry) => entry.id)).toEqual(["a"]);
  });
});

describe("song commands", () => {
  it("registers the v1 section, edit, view and playback commands only", () => {
    expect(SONG_COMMANDS.map((entry) => entry.id)).toEqual([
      "section.moveEarlier",
      "section.moveLater",
      "section.duplicate",
      "section.remove",
      "section.rename",
      "section.changeKind",
      "section.lock",
      "section.unlock",
      "section.loop",
      "section.makeLonger",
      "section.makeShorter",
      "section.split",
      "section.applyBrush",
      "planner.ask",
      "planner.explain",
      "edit.undo",
      "edit.redo",
      "view.history",
      "playback.toggle",
    ]);
    // Generation commands arrive with their work packages (09); the planner v1 only has Ask AI.
    for (const ai of ["regenerate", "continue", "condense", "smooth"]) {
      expect(SONG_COMMANDS.some((entry) => entry.id.includes(ai))).toBe(false);
    }
  });

  it("enables move, lock and resize from the focused part's position and state", () => {
    const first = context({ sectionIndex: 0 });
    expect(command("section.moveEarlier").enabled(first)).toBe(false);
    expect(command("section.moveLater").enabled(first)).toBe(true);

    const last = context({ sectionIndex: 4 });
    expect(command("section.moveLater").enabled(last)).toBe(false);

    expect(command("section.lock").enabled(context())).toBe(true);
    expect(command("section.unlock").enabled(context())).toBe(false);
    expect(
      command("section.unlock").enabled(context({ section: { ...SECTION, locked: true } })),
    ).toBe(true);

    expect(command("section.makeLonger").enabled(context({ sectionBars: 64 }))).toBe(false);
    expect(command("section.makeShorter").enabled(context({ sectionBars: 1 }))).toBe(false);
    expect(command("section.split").enabled(context({ sectionCount: 0 }))).toBe(false);
  });

  it("runs the workspace actions with the focused section", () => {
    const ctx = context();
    command("section.moveEarlier").run(ctx);
    expect(ctx.actions.moveSection).toHaveBeenCalledWith("sec_001", -1);
    command("section.moveLater").run(ctx);
    expect(ctx.actions.moveSection).toHaveBeenCalledWith("sec_001", 1);
    command("section.duplicate").run(ctx);
    expect(ctx.actions.duplicateSection).toHaveBeenCalledWith("sec_001");
    command("section.remove").run(ctx);
    expect(ctx.actions.removeSection).toHaveBeenCalledWith("sec_001");
    command("section.rename").run(ctx);
    expect(ctx.actions.openRename).toHaveBeenCalledWith("sec_001");
    command("section.changeKind").run(ctx);
    expect(ctx.actions.openKind).toHaveBeenCalledWith("sec_001");
    command("section.lock").run(ctx);
    expect(ctx.actions.setLocked).toHaveBeenCalledWith("sec_001", true);
    command("section.loop").run(ctx);
    expect(ctx.actions.loopSection).toHaveBeenCalledWith("sec_001");
    command("section.makeLonger").run(ctx);
    expect(ctx.actions.openResize).toHaveBeenCalledWith("sec_001", "longer");
    command("section.makeShorter").run(ctx);
    expect(ctx.actions.openResize).toHaveBeenCalledWith("sec_001", "shorter");
    command("section.split").run(ctx);
    expect(ctx.actions.splitAtPlayhead).toHaveBeenCalled();
    command("section.applyBrush").run(ctx);
    expect(ctx.actions.openBrush).toHaveBeenCalledWith("sec_001");
    command("edit.undo").run(ctx);
    expect(ctx.actions.undo).toHaveBeenCalled();
    command("edit.redo").run(ctx);
    expect(ctx.actions.redo).toHaveBeenCalled();
    command("view.history").run(ctx);
    expect(ctx.actions.toggleHistory).toHaveBeenCalled();
    command("playback.toggle").run(ctx);
    expect(ctx.actions.togglePlay).toHaveBeenCalled();
    command("planner.ask").run(ctx);
    expect(ctx.actions.askAi).toHaveBeenCalled();
    command("planner.explain").run(ctx);
    expect(ctx.actions.toggleExplain).toHaveBeenCalled();
  });

  it("needs a version tree for undo, redo and the history panel", () => {
    expect(command("edit.undo").enabled(context({ hasHistory: false }))).toBe(false);
    expect(command("edit.redo").enabled(context({ hasHistory: false }))).toBe(false);
    expect(command("view.history").enabled(context({ hasHistory: false }))).toBe(false);
    expect(command("edit.redo").enabled(context({ canRedo: false }))).toBe(false);
  });

  it("offers extending the song only at the edge the focused part touches", () => {
    const last = context({ sectionIndex: 4 });
    const forward = EXTEND_COMMANDS.find((entry) => entry.id === "generation.extendForward");
    const backward = EXTEND_COMMANDS.find((entry) => entry.id === "generation.extendBackward");
    expect(forward?.enabled(last)).toBe(true);
    expect(backward?.enabled(last)).toBe(false);
    forward?.run(last);
    expect(last.actions.openExtend).toHaveBeenCalledWith("forward");

    const first = context({ sectionIndex: 0 });
    expect(backward?.enabled(first)).toBe(true);
    expect(forward?.enabled(first)).toBe(false);
    backward?.run(first);
    expect(first.actions.openExtend).toHaveBeenCalledWith("backward");

    // A part in the middle is neither edge.
    const middle = context({ sectionIndex: 2 });
    expect(forward?.enabled(middle)).toBe(false);
    expect(backward?.enabled(middle)).toBe(false);
    expect(backward?.enabled(context({ section: null }))).toBe(false);
  });
});

describe("palette items", () => {
  it("hides commands that cannot run and shows group, hint and search keywords", () => {
    const items = paletteItems(SONG_COMMANDS, context());
    const ids = items.map((item) => item.id);
    expect(ids).toContain("section.moveEarlier");
    expect(ids).toContain("section.lock");
    expect(ids).not.toContain("section.unlock");
    expect(ids).not.toContain("edit.redo");

    const move = items.find((item) => item.id === "section.moveEarlier");
    expect(move).toMatchObject({ label: "Move part earlier", group: "Part", hint: "Alt+←" });
  });

  it("keeps only global commands when no part is focused", () => {
    const items = paletteItems(SONG_COMMANDS, context({ section: null, sectionIndex: -1 }));
    expect(items.map((item) => item.id)).toEqual([
      "section.split",
      "planner.ask",
      "planner.explain",
      "edit.undo",
      "view.history",
      "playback.toggle",
    ]);
  });
});
