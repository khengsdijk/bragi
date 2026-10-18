import type { Meta, StoryObj } from "@storybook/react-vite";
import { Icon } from "../Icon/Icon.js";
import { IconButton } from "./IconButton.js";

const meta = {
  title: "Components/IconButton",
  component: IconButton,
  parameters: { layout: "centered" },
  args: { label: "Solo this instrument" },
} satisfies Meta<typeof IconButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Solo: Story = {
  args: {
    tooltip: "Hear this instrument alone",
    children: (
      <Icon>
        <path d="M3 8h10M8 3v10" />
      </Icon>
    ),
  },
};

export const Close: Story = {
  args: {
    label: "Close",
    tooltip: "Close",
    children: (
      <Icon>
        <path d="M4 4l8 8M12 4l-8 8" />
      </Icon>
    ),
  },
};

export const Variants: Story = {
  args: {
    label: "Mute",
    children: (
      <Icon>
        <path d="M2 6h3l4-3v10l-4-3H2z" />
      </Icon>
    ),
  },
  render: () => (
    <div className="story-row">
      <IconButton label="Mute" variant="ghost">
        <Icon>
          <path d="M2 6h3l4-3v10l-4-3H2z" />
        </Icon>
      </IconButton>
      <IconButton label="Mute" variant="secondary">
        <Icon>
          <path d="M2 6h3l4-3v10l-4-3H2z" />
        </Icon>
      </IconButton>
      <IconButton label="Mute" variant="primary">
        <Icon>
          <path d="M2 6h3l4-3v10l-4-3H2z" />
        </Icon>
      </IconButton>
      <IconButton label="Mute" variant="danger">
        <Icon>
          <path d="M2 6h3l4-3v10l-4-3H2z" />
        </Icon>
      </IconButton>
    </div>
  ),
};

export const Small: Story = {
  args: {
    size: "sm",
    label: "Solo",
    children: (
      <Icon>
        <path d="M3 8h10" />
      </Icon>
    ),
  },
};

export const Disabled: Story = {
  args: {
    label: "Solo",
    disabled: true,
    children: (
      <Icon>
        <path d="M3 8h10" />
      </Icon>
    ),
  },
};
