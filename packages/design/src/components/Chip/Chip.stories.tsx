import type { Meta, StoryObj } from "@storybook/react-vite";

import { Icon } from "../Icon/Icon.js";
import { Chip } from "./Chip.js";

const meta = {
  title: "Components/Chip",
  component: Chip,
  parameters: { layout: "centered" },
  args: { children: "Half-time" },
} satisfies Meta<typeof Chip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Suggestion: Story = {};

export const Selectable: Story = {
  args: { children: "More lo-fi", onSelect: () => {}, selected: true },
};

export const WithIcon: Story = {
  args: {
    children: "Smooth with AI",
    onSelect: () => {},
    icon: (
      <Icon>
        <path d="M8 2l1.5 4L14 7.5 9.5 9 8 13 6.5 9 2 7.5 6.5 6z" />
      </Icon>
    ),
  },
};

export const RoleSwatch: Story = {
  render: () => (
    <div className="story-row">
      <Chip stemRole="vocals">Vocals</Chip>
      <Chip stemRole="drums">Drums</Chip>
      <Chip stemRole="bass">Bass</Chip>
      <Chip stemRole="guitar">Guitar</Chip>
      <Chip stemRole="piano">Piano</Chip>
      <Chip stemRole="synth">Synths</Chip>
      <Chip stemRole="strings">Strings</Chip>
      <Chip stemRole="generated">Generated</Chip>
      <Chip stemRole="residual">Other</Chip>
    </div>
  ),
};

export const SectionKinds: Story = {
  render: () => (
    <div className="story-row">
      <Chip sectionKind="intro">Intro</Chip>
      <Chip sectionKind="verse">Verse</Chip>
      <Chip sectionKind="pre_chorus">Pre-chorus</Chip>
      <Chip sectionKind="chorus">Chorus</Chip>
      <Chip sectionKind="bridge">Bridge</Chip>
      <Chip sectionKind="build">Build-up</Chip>
      <Chip sectionKind="drop">Drop</Chip>
      <Chip sectionKind="breakdown">Breakdown</Chip>
      <Chip sectionKind="custom">Custom</Chip>
    </div>
  ),
};

export const Tones: Story = {
  render: () => (
    <div className="story-row">
      <Chip>Neutral</Chip>
      <Chip tone="accent">Uses 2 credits</Chip>
      <Chip tone="danger">Removed</Chip>
    </div>
  ),
};
