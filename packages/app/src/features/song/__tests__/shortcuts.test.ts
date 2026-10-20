import { describe, expect, it } from "vitest";

import { resolveSongShortcut, type ShortcutKey } from "../state/shortcuts.js";

function key(key: string, modifiers: Partial<Omit<ShortcutKey, "key">> = {}): ShortcutKey {
  return {
    key,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    ...modifiers,
  };
}

describe("section keyboard map (11 §6.2)", () => {
  it("moves with Alt+arrows and resizes with Alt+Shift+arrows", () => {
    expect(resolveSongShortcut(key("ArrowLeft", { altKey: true }))).toEqual({
      kind: "move",
      delta: -1,
    });
    expect(resolveSongShortcut(key("ArrowRight", { altKey: true }))).toEqual({
      kind: "move",
      delta: 1,
    });
    expect(resolveSongShortcut(key("ArrowLeft", { altKey: true, shiftKey: true }))).toEqual({
      kind: "resize",
      delta: -1,
    });
    expect(resolveSongShortcut(key("ArrowRight", { altKey: true, shiftKey: true }))).toEqual({
      kind: "resize",
      delta: 1,
    });
  });

  it("removes with Delete or Backspace, but leaves modified deletes alone", () => {
    expect(resolveSongShortcut(key("Delete"))).toEqual({ kind: "remove" });
    expect(resolveSongShortcut(key("Backspace"))).toEqual({ kind: "remove" });
    expect(resolveSongShortcut(key("Delete", { metaKey: true }))).toBeNull();
    expect(resolveSongShortcut(key("Delete", { altKey: true }))).toBeNull();
  });

  it("opens the palette with Cmd/Ctrl+K and undoes/redoes with Cmd/Ctrl+Z", () => {
    expect(resolveSongShortcut(key("k", { metaKey: true }))).toEqual({ kind: "palette" });
    expect(resolveSongShortcut(key("K", { ctrlKey: true }))).toEqual({ kind: "palette" });
    expect(resolveSongShortcut(key("z", { metaKey: true }))).toEqual({ kind: "undo" });
    expect(resolveSongShortcut(key("z", { ctrlKey: true, shiftKey: true }))).toEqual({
      kind: "redo",
    });
  });

  it("ignores plain navigation and unrelated keys", () => {
    expect(resolveSongShortcut(key("ArrowLeft"))).toBeNull();
    expect(resolveSongShortcut(key(" "))).toBeNull();
    expect(resolveSongShortcut(key("z"))).toBeNull();
    expect(resolveSongShortcut(key("k", { altKey: true }))).toBeNull();
  });
});
