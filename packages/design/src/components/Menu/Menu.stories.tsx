import type { Meta, StoryObj } from "@storybook/react-vite";

import { Button } from "../Button/Button.js";
import { Icon } from "../Icon/Icon.js";
import { Menu, MenuGroup, MenuItem, MenuLabel, MenuSeparator } from "./Menu.js";

const meta = {
  title: "Components/Menu",
  component: Menu,
  parameters: { layout: "centered" },
  args: { trigger: <Button>Section actions</Button>, children: null },
} satisfies Meta<typeof Menu>;

export default meta;
type Story = StoryObj<typeof meta>;

function SectionMenu() {
  return (
    <>
      <MenuGroup label="Edit">
        <MenuItem
          icon={
            <Icon>
              <path d="M3 3h7v7H3zM6 6h7v7H6z" />
            </Icon>
          }
          shortcut="⌘D"
        >
          Duplicate
        </MenuItem>
        <MenuItem shortcut="F2">Rename</MenuItem>
        <MenuItem>Change type</MenuItem>
        <MenuItem>Lock from AI</MenuItem>
      </MenuGroup>
      <MenuSeparator />
      <MenuGroup label="Length">
        <MenuItem>Make longer…</MenuItem>
        <MenuItem>Make shorter…</MenuItem>
      </MenuGroup>
      <MenuSeparator />
      <MenuItem tone="danger" shortcut="⌫">
        Remove
      </MenuItem>
      <MenuLabel>Tools</MenuLabel>
      <MenuItem disabled>Regenerate…</MenuItem>
    </>
  );
}

export const Closed: Story = { args: { children: <SectionMenu /> } };

/**
 * The default (modal) menu, shown open. Its trigger is disabled because there is nothing left to
 * open: a modal menu paints `aria-hidden` over the page behind it, so a focusable trigger would
 * be hidden from assistive tech while still reachable by keyboard in a static story.
 */
export const OpenModal: Story = {
  args: {
    children: <SectionMenu />,
    defaultOpen: true,
    trigger: <Button disabled>Section actions</Button>,
  },
};

/**
 * Rendered open, so axe scans the menu items too. Non-modal here: a modal menu paints
 * `aria-hidden` over everything behind it, including its own trigger, which axe's
 * `aria-hidden-focus` rule flags even though Radix also traps focus. The default stays modal.
 */
export const Open: Story = { args: { children: <SectionMenu />, defaultOpen: true, modal: false } };
