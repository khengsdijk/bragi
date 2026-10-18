import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

import { CommandPalette, type CommandPaletteItem } from "./CommandPalette.js";

const ITEMS: readonly CommandPaletteItem[] = [
  { id: "undo", label: "Undo", group: "Edit", hint: "⌘Z", keywords: ["revert", "back"] },
  { id: "redo", label: "Redo", group: "Edit", hint: "⇧⌘Z" },
  { id: "duplicate", label: "Duplicate section", group: "Edit", hint: "⌘D" },
  { id: "solo", label: "Solo the hovered instrument", group: "Playback", hint: "M" },
  { id: "mute", label: "Mute the hovered instrument", group: "Playback", hint: "O" },
  { id: "spacious", label: "More spacious", group: "Vibe", keywords: ["reverb", "space"] },
  { id: "punchy", label: "More punchy", group: "Vibe", keywords: ["compression"] },
  { id: "extend", label: "Make the song longer…", group: "Song" },
  { id: "export", label: "Export song", group: "Song", hint: "⌘E" },
  { id: "delete", label: "Delete section", group: "Song", disabled: true },
];

const meta = {
  title: "Components/CommandPalette",
  component: CommandPalette,
  parameters: { layout: "fullscreen" },
  args: {
    open: true,
    onOpenChange: () => {},
    items: ITEMS,
    onSelect: () => {},
    label: "Commands",
    placeholder: "Type a command or search",
    emptyLabel: "No matching commands",
  },
} satisfies Meta<typeof CommandPalette>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {};

export const WithFooter: Story = {
  args: {
    footer: (
      <>
        <span>↑↓ to move</span>
        <span>⏎ to run</span>
        <span>Esc to close</span>
      </>
    ),
  },
};

function Filtered() {
  const [open, setOpen] = useState(true);
  return (
    <CommandPalette
      open={open}
      onOpenChange={setOpen}
      items={ITEMS}
      onSelect={() => setOpen(false)}
      label="Commands"
      placeholder="Try 'spread'"
      emptyLabel="No matching commands"
      footer={<span>Everything stays keyboard reachable (11 §6.2)</span>}
    />
  );
}

export const Typed: Story = { render: () => <Filtered /> };

export const Empty: Story = {
  args: { items: [] },
};
