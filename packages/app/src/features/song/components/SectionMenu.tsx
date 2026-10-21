/**
 * The section context menu (07 §4.1, 11 §6.2): the same commands as the palette, minus the ones
 * that need a visible list (move, split) and plus the "Smooth new joins" setting.
 *
 * It is a controlled Radix Dropdown Menu anchored to the point where the user right-clicked a
 * block (or pressed Shift+F10 on a grid cell). Radix needs a trigger, so it is a visually hidden
 * button at that point; on close, focus returns to the element that had it (the canvas or the
 * grid cell), not to the hidden trigger.
 */
import { Button, Menu, MenuCheckboxItem, MenuItem, MenuSeparator } from "@bragi/design";
import type { ReactNode } from "react";

import { t } from "../../../i18n/index.js";
import type { Command, CommandContext } from "../../commands/state/commands.js";

export interface SectionMenuAnchor {
  readonly x: number;
  readonly y: number;
  /** The element that had focus before the menu opened. */
  readonly returnFocus: HTMLElement | null;
}

export interface SectionMenuProps {
  readonly anchor: SectionMenuAnchor | null;
  readonly onClose: () => void;
  readonly commands: readonly Command[];
  readonly context: CommandContext;
  readonly smartTransitions: boolean;
  readonly onSmartTransitionsChange: (value: boolean) => void;
}

export function SectionMenu({
  anchor,
  onClose,
  commands,
  context,
  smartTransitions,
  onSmartTransitionsChange,
}: SectionMenuProps): ReactNode {
  if (anchor === null) return null;

  const command = (id: string): Command | undefined => commands.find((entry) => entry.id === id);
  const item = (id: string): ReactNode => {
    const entry = command(id);
    if (entry === undefined) return null;
    return (
      <MenuItem
        key={entry.id}
        disabled={!entry.enabled(context)}
        tone={entry.id === "section.remove" ? "danger" : "default"}
        {...(entry.shortcut === undefined ? {} : { shortcut: entry.shortcut })}
        onSelect={() => entry.run(context)}
      >
        {t(entry.label)}
      </MenuItem>
    );
  };

  // A context menu should not hide the song from assistive tech, so it stays non-modal.
  return (
    <Menu
      key={`${anchor.x}:${anchor.y}`}
      open
      modal={false}
      onOpenChange={(open) => {
        if (open) return;
        const target = anchor.returnFocus;
        // Radix reports the close before it runs the chosen item's `onSelect`. Unmounting the
        // controlled menu in the same tick would cancel the action, so let the event finish.
        setTimeout(() => {
          onClose();
          // The portal is gone now; put focus back where the menu was opened.
          if (target?.isConnected === true) target.focus();
        }, 0);
      }}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        anchor.returnFocus?.focus();
      }}
      trigger={
        <Button
          variant="ghost"
          size="sm"
          tabIndex={-1}
          disabled
          aria-hidden="true"
          aria-label={t("song.sectionMenu.label")}
          data-testid="section-menu-anchor"
          style={{
            position: "fixed",
            left: anchor.x,
            top: anchor.y,
            width: 1,
            height: 1,
            minWidth: 0,
            padding: 0,
            overflow: "hidden",
            opacity: 0,
            pointerEvents: "none",
            clipPath: "inset(50%)",
          }}
        >
          {t("song.sectionMenu.label")}
        </Button>
      }
      label={t("song.sectionMenu.label")}
    >
      {item("section.duplicate")}
      {item("section.remove")}
      <MenuSeparator />
      {item("section.rename")}
      {item("section.changeKind")}
      <MenuSeparator />
      {context.section?.locked === true ? item("section.unlock") : item("section.lock")}
      <MenuSeparator />
      {item("section.loop")}
      {item("section.makeLonger")}
      {item("section.makeShorter")}
      <MenuSeparator />
      {item("generation.extendForward")}
      {item("generation.extendBackward")}
      <MenuSeparator />
      {item("section.applyBrush")}
      <MenuSeparator />
      <MenuCheckboxItem checked={smartTransitions} onCheckedChange={onSmartTransitionsChange}>
        {t("song.sectionMenu.smooth")}
      </MenuCheckboxItem>
    </Menu>
  );
}
