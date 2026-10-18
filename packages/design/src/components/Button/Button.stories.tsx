import type { Meta, StoryObj } from "@storybook/react-vite";
import { Icon } from "../Icon/Icon.js";
import { Button } from "./Button.js";

const meta = {
  title: "Components/Button",
  component: Button,
  parameters: { layout: "centered" },
  args: { children: "Play" },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = { args: { variant: "primary", children: "Continue with AI" } };
export const Secondary: Story = { args: { variant: "secondary", children: "Export song" } };
export const Ghost: Story = { args: { variant: "ghost", children: "Cancel" } };
export const Danger: Story = { args: { variant: "danger", children: "Remove section" } };

export const Sizes: Story = {
  render: () => (
    <div className="story-row">
      <Button size="sm">Small</Button>
      <Button size="md">Medium</Button>
      <Button size="lg">Large</Button>
    </div>
  ),
};

export const WithIcons: Story = {
  args: {
    children: "Play from here",
    iconLeft: (
      <Icon>
        <path d="M5 3l8 5-8 5z" />
      </Icon>
    ),
    size: "lg",
    variant: "primary",
  },
};

export const Loading: Story = {
  args: { children: "Export song", variant: "primary", loading: true, loadingLabel: "Exporting" },
};

export const Disabled: Story = { args: { children: "Continue with AI", disabled: true } };

export const AsLink: Story = {
  args: { asChild: true, variant: "ghost", children: "Open the Universe" },
  render: (args) => (
    <Button {...args}>
      <a href="#universe">Open the Universe</a>
    </Button>
  ),
};
