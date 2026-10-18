import type { Meta, StoryObj } from "@storybook/react-vite";

import { Button } from "../Button/Button.js";
import { Tooltip, TooltipProvider } from "./Tooltip.js";

const meta = {
  title: "Components/Tooltip",
  component: Tooltip,
  parameters: { layout: "centered" },
  args: { content: "Uses 2 credits", children: <Button>Clean up rough edges</Button> },
} satisfies Meta<typeof Tooltip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Closed: Story = {};

/** Rendered open, so axe scans the tooltip's content too. */
export const Open: Story = { args: { defaultOpen: true } };

export const NeedsInternet: Story = {
  args: {
    defaultOpen: true,
    content: "Needs internet",
    children: <Button disabled>Continue with AI</Button>,
  },
};

export const InAProvider: Story = {
  render: () => (
    <TooltipProvider>
      <Tooltip content="Drag to set the energy for this part">
        <Button>Energy</Button>
      </Tooltip>
    </TooltipProvider>
  ),
  args: {},
};
