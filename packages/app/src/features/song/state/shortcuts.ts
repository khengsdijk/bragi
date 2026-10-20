/**
 * The section keyboard map (11 §6.2), as a pure function.
 *
 * Keeping the decision separate from the DOM listener means the shortcuts are tested without a
 * canvas, and the workspace only has to decide whether the focused control owns its keys.
 */
export type SongShortcut =
  | { readonly kind: "move"; readonly delta: -1 | 1 }
  | { readonly kind: "resize"; readonly delta: -1 | 1 }
  | { readonly kind: "remove" }
  | { readonly kind: "palette" }
  | { readonly kind: "undo" }
  | { readonly kind: "redo" };

export interface ShortcutKey {
  readonly key: string;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
}

/**
 * `Alt+←/→` moves a part, `Alt+Shift+←/→` shortens/lengthens it by a bar, Delete/Backspace
 * removes it, `Cmd/Ctrl+Z` undoes (with Shift, redoes) and `Cmd/Ctrl+K` opens the palette.
 */
export function resolveSongShortcut(event: ShortcutKey): SongShortcut | null {
  if (event.metaKey || event.ctrlKey) {
    const key = event.key.toLowerCase();
    if (key === "k") return { kind: "palette" };
    if (key === "z") return { kind: event.shiftKey ? "redo" : "undo" };
    return null;
  }
  if (event.altKey) {
    if (event.key === "ArrowLeft") {
      return event.shiftKey ? { kind: "resize", delta: -1 } : { kind: "move", delta: -1 };
    }
    if (event.key === "ArrowRight") {
      return event.shiftKey ? { kind: "resize", delta: 1 } : { kind: "move", delta: 1 };
    }
    return null;
  }
  if (event.key === "Delete" || event.key === "Backspace") return { kind: "remove" };
  return null;
}
