/**
 * The v1 song commands (07 §3, 11 §6.2). AI commands (Regenerate, Explain, Continue with AI,
 * Condense, Smooth with AI) are deliberately absent until their work packages land (09).
 */
import { t } from "../../../i18n/index.js";
import type { Command, CommandContext } from "./commands.js";

const hasSection = (context: CommandContext): boolean => context.section !== null;

export const SONG_COMMANDS: readonly Command[] = [
  {
    id: "section.moveEarlier",
    label: "commands.section.moveEarlier",
    shortcut: t("shortcut.moveEarlier"),
    group: "section",
    enabled: (context) => hasSection(context) && context.sectionIndex > 0,
    run: (context) => {
      if (context.section !== null) context.actions.moveSection(context.section.id, -1);
    },
  },
  {
    id: "section.moveLater",
    label: "commands.section.moveLater",
    shortcut: t("shortcut.moveLater"),
    group: "section",
    enabled: (context) => hasSection(context) && context.sectionIndex < context.sectionCount - 1,
    run: (context) => {
      if (context.section !== null) context.actions.moveSection(context.section.id, 1);
    },
  },
  {
    id: "section.duplicate",
    label: "commands.section.duplicate",
    group: "section",
    enabled: hasSection,
    run: (context) => {
      if (context.section !== null) context.actions.duplicateSection(context.section.id);
    },
  },
  {
    id: "section.remove",
    label: "commands.section.remove",
    shortcut: t("shortcut.remove"),
    group: "section",
    enabled: hasSection,
    run: (context) => {
      if (context.section !== null) context.actions.removeSection(context.section.id);
    },
  },
  {
    id: "section.rename",
    label: "commands.section.rename",
    group: "section",
    enabled: hasSection,
    run: (context) => {
      if (context.section !== null) context.actions.openRename(context.section.id);
    },
  },
  {
    id: "section.changeKind",
    label: "commands.section.changeKind",
    group: "section",
    enabled: hasSection,
    run: (context) => {
      if (context.section !== null) context.actions.openKind(context.section.id);
    },
  },
  {
    id: "section.lock",
    label: "commands.section.lock",
    group: "section",
    enabled: (context) => context.section !== null && context.section.locked !== true,
    run: (context) => {
      if (context.section !== null) context.actions.setLocked(context.section.id, true);
    },
  },
  {
    id: "section.unlock",
    label: "commands.section.unlock",
    group: "section",
    enabled: (context) => context.section?.locked === true,
    run: (context) => {
      if (context.section !== null) context.actions.setLocked(context.section.id, false);
    },
  },
  {
    id: "section.loop",
    label: "commands.section.loop",
    group: "section",
    enabled: hasSection,
    run: (context) => {
      if (context.section !== null) context.actions.loopSection(context.section.id);
    },
  },
  {
    id: "section.makeLonger",
    label: "commands.section.makeLonger",
    shortcut: t("shortcut.longer"),
    group: "section",
    enabled: (context) => hasSection(context) && context.sectionBars < 64,
    run: (context) => {
      if (context.section !== null) context.actions.openResize(context.section.id, "longer");
    },
  },
  {
    id: "section.makeShorter",
    label: "commands.section.makeShorter",
    shortcut: t("shortcut.shorter"),
    group: "section",
    enabled: (context) => hasSection(context) && context.sectionBars > 1,
    run: (context) => {
      if (context.section !== null) context.actions.openResize(context.section.id, "shorter");
    },
  },
  {
    id: "section.split",
    label: "commands.section.split",
    group: "section",
    enabled: (context) => context.sectionCount > 0,
    run: (context) => context.actions.splitAtPlayhead(),
  },
  {
    id: "section.applyBrush",
    label: "commands.section.applyBrush",
    group: "section",
    enabled: hasSection,
    run: (context) => {
      if (context.section !== null) context.actions.openBrush(context.section.id);
    },
  },
  {
    id: "edit.undo",
    label: "commands.edit.undo",
    shortcut: t("shortcut.undo"),
    group: "edit",
    enabled: (context) => context.hasHistory && context.canUndo,
    run: (context) => context.actions.undo(),
  },
  {
    id: "edit.redo",
    label: "commands.edit.redo",
    shortcut: t("shortcut.redo"),
    group: "edit",
    enabled: (context) => context.hasHistory && context.canRedo,
    run: (context) => context.actions.redo(),
  },
  {
    id: "view.history",
    label: "commands.view.history",
    group: "view",
    enabled: (context) => context.hasHistory,
    run: (context) => context.actions.toggleHistory(),
  },
  {
    id: "playback.toggle",
    label: "commands.playback.toggle",
    shortcut: t("shortcut.play"),
    group: "playback",
    enabled: () => true,
    run: (context) => context.actions.togglePlay(),
  },
];

/**
 * The AI commands that only exist while a generation host is configured (09 §4.2, 07 §4.2).
 * The workspace adds them to the registry when the canvas can reach a generation worker, so the
 * palette and the section menu never offer an action that cannot run.
 */
export const EXTEND_COMMANDS: readonly Command[] = [
  {
    id: "generation.extendForward",
    label: "commands.generation.extendForward",
    group: "generation",
    keywords: ["extend", "continue", "outro", "longer", "ai"],
    enabled: (context) =>
      hasSection(context) &&
      context.sectionCount > 0 &&
      context.sectionIndex === context.sectionCount - 1,
    run: (context) => context.actions.openExtend("forward"),
  },
  {
    id: "generation.extendBackward",
    label: "commands.generation.extendBackward",
    group: "generation",
    keywords: ["intro", "before", "start", "ai"],
    enabled: (context) => hasSection(context) && context.sectionIndex === 0,
    run: (context) => context.actions.openExtend("backward"),
  },
];
