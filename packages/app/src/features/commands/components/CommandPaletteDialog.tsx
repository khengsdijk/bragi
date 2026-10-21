/**
 * The command palette (`Cmd/Ctrl+K`, 11 §6.2).
 *
 * It shows only commands that are available for the current context. A command that cannot run
 * (no part focused, nothing to undo) is omitted rather than shown disabled: the palette is for
 * doing, and the context menu already carries the disabled states where the whole list belongs.
 */
import { CommandPalette, type CommandPaletteItem } from "@bragi/design";
import type { ReactNode } from "react";

import { type MessageKey, t } from "../../../i18n/index.js";
import type { Command, CommandContext, CommandGroup } from "../state/commands.js";

const GROUP_KEYS: Readonly<Record<CommandGroup, MessageKey>> = {
  section: "commands.group.section",
  generation: "commands.group.generation",
  edit: "commands.group.edit",
  view: "commands.group.view",
  playback: "commands.group.playback",
};

/** What the palette lists for a context; exported so the filtering rules are unit-tested. */
export function paletteItems(
  commands: readonly Command[],
  context: CommandContext,
): CommandPaletteItem[] {
  return commands
    .filter((command) => command.enabled(context))
    .map((command) => ({
      id: command.id,
      label: t(command.label),
      group: t(GROUP_KEYS[command.group]),
      ...(command.shortcut === undefined ? {} : { hint: command.shortcut }),
      ...(command.keywords === undefined ? {} : { keywords: command.keywords }),
    }));
}

export interface CommandPaletteDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly commands: readonly Command[];
  readonly context: CommandContext;
}

export function CommandPaletteDialog({
  open,
  onOpenChange,
  commands,
  context,
}: CommandPaletteDialogProps): ReactNode {
  const items = paletteItems(commands, context);
  return (
    <CommandPalette
      open={open}
      onOpenChange={onOpenChange}
      items={items}
      onSelect={(item) => {
        commands.find((command) => command.id === item.id)?.run(context);
      }}
      label={t("commands.palette.label")}
      placeholder={t("commands.palette.placeholder")}
      emptyLabel={t("commands.palette.empty")}
    />
  );
}
