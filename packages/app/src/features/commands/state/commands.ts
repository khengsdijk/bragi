/**
 * The command registry (07 §3, 11 §6.2): one typed description per action, shared by the palette,
 * the context menu and the keyboard shortcuts.
 *
 * A command never touches the document itself. It receives a {@link CommandContext} that says what
 * is focused and carries the {@link CommandActions} the workspace built, so the same command can
 * serve a selected part on the canvas, a focused grid cell or the palette.
 */
import type { SectionInstance } from "@bragi/schemas";

import type { MessageKey } from "../../../i18n/index.js";

/** Palette headings, in this order. */
export type CommandGroup = "section" | "generation" | "edit" | "view" | "playback";

/** Everything a command may read or do. */
export interface CommandContext {
  /** The focused or selected part, when there is exactly one. */
  readonly section: SectionInstance | null;
  readonly sectionIndex: number;
  readonly sectionCount: number;
  /** The section's length in whole bars, for the resize commands. */
  readonly sectionBars: number;
  readonly smartTransitions: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly hasHistory: boolean;
  readonly historyOpen: boolean;
  readonly playing: boolean;
  /** Explain mode is on (07 §4.9). */
  readonly explainMode: boolean;
  /** The erased gap's description when a Fill gap chip is available (07 §4.8). */
  readonly fillGapLabel: string | null;
  /** The incoming sections whose new boundary a Smooth chip offers (07 §4.1). */
  readonly smoothTargetIds: readonly string[];
  readonly actions: CommandActions;
}

/** The workspace's implementations. Commands stay platform- and store-agnostic. */
export interface CommandActions {
  moveSection(sectionId: string, delta: -1 | 1): void;
  duplicateSection(sectionId: string): void;
  removeSection(sectionId: string): void;
  openRename(sectionId: string): void;
  openKind(sectionId: string): void;
  setLocked(sectionId: string, locked: boolean): void;
  loopSection(sectionId: string): void;
  openResize(sectionId: string, direction: "longer" | "shorter"): void;
  /** Opens the extend popover at the song edge this part touches (07 §4.2, 09 §4.2). */
  openExtend(direction: "forward" | "backward"): void;
  /** Fills the gap the last erase left (07 §4.8, 09 §4.3). */
  fillGap(): void;
  /** Opens the ✨ Smooth with AI popover on this boundary (07 §4.1, 09 §4.4). */
  smoothTransition(sectionId: string): void;
  /** The keyboard painting path: pick a brush and apply it to a whole part (11 §6.2). */
  openBrush(sectionId: string): void;
  splitAtPlayhead(): void;
  undo(): void;
  redo(): void;
  toggleHistory(): void;
  togglePlay(): void;
  /** Opens the prompt bar on the current selection, or the whole song (07 §4.3, §5). */
  askAi(): void;
  /** Turns Explain mode on or off (07 §4.9). */
  toggleExplain(): void;
}

export interface Command {
  readonly id: string;
  /** i18n key; the palette and the menu resolve it (11 §2). */
  readonly label: MessageKey;
  /** Display form of the keyboard shortcut, when it has one. */
  readonly shortcut?: string;
  readonly group: CommandGroup;
  /** Extra search terms for the palette, in addition to the label. */
  readonly keywords?: readonly string[];
  enabled(context: CommandContext): boolean;
  run(context: CommandContext): void;
}

export interface CommandRegistry {
  /** Adds or replaces a command; returns a function that removes it again. */
  register(command: Command): () => void;
  /** Every command, in registration order. */
  list(): readonly Command[];
  get(id: string): Command | undefined;
}

export function createCommandRegistry(initial: readonly Command[] = []): CommandRegistry {
  const commands = new Map<string, Command>();
  const register = (command: Command): (() => void) => {
    commands.set(command.id, command);
    return () => {
      if (commands.get(command.id) === command) commands.delete(command.id);
    };
  };
  for (const command of initial) register(command);
  return {
    register,
    list: () => [...commands.values()],
    get: (id) => commands.get(id),
  };
}
