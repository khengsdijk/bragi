import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

import { Slider } from "./Slider.js";
import { VibeSlider } from "./VibeSlider.js";

const meta = {
  title: "Components/Slider",
  component: Slider,
  parameters: { layout: "centered" },
} satisfies Meta<typeof Slider>;

export default meta;
type Story = StoryObj<typeof meta>;

function Volume({ expert }: { readonly expert: boolean }) {
  const [value, setValue] = useState(0.7);
  return (
    <div className="story-stack">
      <Slider
        value={value}
        onValueChange={setValue}
        label="Instrument volume"
        formatValue={(next) => (expert ? `${Math.round(next * 60 - 60)} dB` : "louder")}
        showValue={expert}
      />
    </div>
  );
}

/** Simple mode: action words, no numbers (11 §5). */
export const SimpleMode: Story = {
  render: () => <Volume expert={false} />,
  args: { label: "Instrument volume", value: 0.7, onValueChange: () => {} },
};

/** Expert mode: the same slider, with the value shown. */
export const ExpertMode: Story = {
  render: () => <Volume expert />,
  args: { label: "Instrument volume", value: 0.7, onValueChange: () => {} },
};

function Vibe() {
  const [brightness, setBrightness] = useState(-0.4);
  const [space, setSpace] = useState(0);
  return (
    <div className="story-stack">
      <VibeSlider
        value={brightness}
        onValueChange={setBrightness}
        label="Brightness"
        endLabels={["Darker", "Brighter"]}
        getValueText={(value) => (value === 0 ? "unchanged" : value > 0 ? "brighter" : "darker")}
      />
      <VibeSlider
        value={space}
        onValueChange={setSpace}
        label="Space"
        endLabels={["Dry", "Spacious"]}
        getValueText={(value) =>
          value === 0 ? "unchanged" : value > 0 ? "more spacious" : "drier"
        }
      />
    </div>
  );
}

/** The bipolar vibe sliders from [07 §4.5]: the fill grows out of the middle. */
export const VibeSliders: Story = {
  render: () => <Vibe />,
  args: { label: "Brightness", value: 0, onValueChange: () => {} },
};

/** Every expert-mode axis, all neutral. */
export const VibeAxesNeutral: Story = {
  render: () => {
    const axes: readonly [string, string, string][] = [
      ["Brightness", "Darker", "Brighter"],
      ["Space", "Dry", "Spacious"],
      ["Punch", "Soft", "Punchy"],
      ["Warmth", "Clean", "Warm"],
      ["Era", "Modern", "Vintage"],
      ["Distance", "Close", "Distant"],
    ];
    return <NeutralAxes axes={axes} />;
  },
  args: { label: "Brightness", value: 0, onValueChange: () => {} },
};

function NeutralAxes({ axes }: { readonly axes: readonly (readonly [string, string, string])[] }) {
  const [values, setValues] = useState<Record<string, number>>({});
  return (
    <div className="story-stack">
      {axes.map(([label, low, high]) => (
        <VibeSlider
          key={label}
          value={values[label] ?? 0}
          onValueChange={(next) => setValues((previous) => ({ ...previous, [label]: next }))}
          label={label}
          endLabels={[low, high]}
          getValueText={(value) =>
            value === 0 ? "unchanged" : value > 0 ? high.toLowerCase() : low.toLowerCase()
          }
        />
      ))}
    </div>
  );
}
