import type { Meta, StoryObj } from "@storybook/react-vite";

import { Button } from "../Button/Button.js";
import { Popover } from "./Popover.js";

const meta = {
  title: "Components/Popover",
  component: Popover,
  parameters: { layout: "centered" },
  args: {
    label: "How should it get longer?",
    trigger: <Button>Make longer…</Button>,
    children: <p>Loop, stretch or continue with AI.</p>,
  },
} satisfies Meta<typeof Popover>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Closed: Story = {};

/** Rendered open, so axe scans the panel's content too. */
export const Open: Story = { args: { defaultOpen: true } };

export const Explain: Story = {
  args: {
    label: "Explain",
    defaultOpen: true,
    trigger: <Button variant="ghost">Explain</Button>,
    children: (
      <div className="story-stack">
        <p>This is the chorus: the loudest, most repeated part.</p>
        <p>It borrows the drums from Verse 2 and raises the energy by 40%.</p>
      </div>
    ),
  },
};
