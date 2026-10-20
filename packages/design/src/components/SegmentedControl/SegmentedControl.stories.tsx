import type { Meta, StoryObj } from "@storybook/react-vite";

import { SegmentedControl } from "./SegmentedControl.js";

const meta = {
  title: "Components/SegmentedControl",
  component: SegmentedControl,
  parameters: { layout: "centered" },
  args: {
    label: "Mode",
    value: "0",
    options: [
      { value: "0", label: "Low-pass" },
      { value: "1", label: "High-pass" },
      { value: "2", label: "Band-pass" },
    ],
    onChange: () => {},
  },
} satisfies Meta<typeof SegmentedControl>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithDisabledOption: Story = {
  args: {
    options: [
      { value: "0", label: "Low-pass" },
      { value: "1", label: "High-pass", disabled: true },
      { value: "2", label: "Band-pass" },
    ],
  },
};
