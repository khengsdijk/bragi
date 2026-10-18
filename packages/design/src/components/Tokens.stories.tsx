import type { Meta, StoryObj } from "@storybook/react-vite";
import { Fragment } from "react";

import { ROLE_TOKEN_LIST, SECTION_FAMILY_LIST } from "../tokens/mapping.js";

/**
 * The token set itself, as something to look at: both themes, every role and section colour, the
 * energy gradient and the type scale. Acceptance 1 and 2 are about the numbers behind these
 * swatches, not about this page.
 */
const meta = {
  title: "Tokens/Palette",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function Swatch({ token, label }: { readonly token: string; readonly label: string }) {
  return (
    <div style={{ display: "grid", gap: "var(--space-1)", minWidth: "7rem" }}>
      <div
        style={{
          background: `var(${token})`,
          height: "3rem",
          borderRadius: "var(--radius-md)",
          border: "1px solid var(--color-line-strong)",
        }}
      />
      <code style={{ fontSize: "var(--text-xs)", color: "var(--color-text-muted)" }}>{token}</code>
      <span style={{ fontSize: "var(--text-xs)" }}>{label}</span>
    </div>
  );
}

function Row({
  tokens,
  labels,
}: {
  readonly tokens: readonly string[];
  readonly labels: readonly string[];
}) {
  return (
    <div className="story-row" style={{ alignItems: "flex-start" }}>
      {tokens.map((token, index) => (
        <Fragment key={token}>
          <Swatch token={token} label={labels[index] ?? ""} />
        </Fragment>
      ))}
    </div>
  );
}

export const Everything: Story = {
  render: () => (
    <div className="story-stack" style={{ maxWidth: "none" }}>
      <section className="story-panel">
        <h2 style={{ margin: 0, fontSize: "var(--text-xl)" }}>Instrument roles</h2>
        <Row tokens={ROLE_TOKEN_LIST.map((role) => `--role-${role}`)} labels={ROLE_TOKEN_LIST} />
      </section>

      <section className="story-panel">
        <h2 style={{ margin: 0, fontSize: "var(--text-xl)" }}>Section families</h2>
        <Row
          tokens={SECTION_FAMILY_LIST.map((family) => `--section-fill-${family}`)}
          labels={SECTION_FAMILY_LIST}
        />
      </section>

      <section className="story-panel">
        <h2 style={{ margin: 0, fontSize: "var(--text-xl)" }}>Energy gradient</h2>
        <div
          style={{
            height: "3rem",
            borderRadius: "var(--radius-md)",
            background:
              "linear-gradient(90deg, var(--energy-stop-1), var(--energy-stop-2), var(--energy-stop-3), var(--energy-stop-4), var(--energy-stop-5))",
          }}
        />
        <Row
          tokens={[
            "--energy-stop-1",
            "--energy-stop-2",
            "--energy-stop-3",
            "--energy-stop-4",
            "--energy-stop-5",
          ]}
          labels={["low", "", "medium", "", "high"]}
        />
      </section>

      <section className="story-panel">
        <h2 style={{ margin: 0, fontSize: "var(--text-xl)" }}>Text and surfaces</h2>
        <Row
          tokens={[
            "--color-text",
            "--color-text-muted",
            "--color-text-disabled",
            "--color-accent",
            "--color-danger",
            "--color-success",
            "--color-warning",
            "--color-info",
            "--color-focus",
          ]}
          labels={[
            "text",
            "muted",
            "disabled",
            "accent",
            "danger",
            "success",
            "warning",
            "info",
            "focus",
          ]}
        />
      </section>
    </div>
  ),
};

export const Typography: Story = {
  render: () => (
    <div className="story-stack">
      <p style={{ fontSize: "var(--text-2xl)", margin: 0 }}>Midnight Drive</p>
      <p style={{ fontSize: "var(--text-xl)", margin: 0 }}>Song layout</p>
      <p style={{ fontSize: "var(--text-lg)", margin: 0 }}>Chorus 2 moved after Verse 3</p>
      <p style={{ fontSize: "var(--text-base)", margin: 0 }}>
        Each ribbon is an instrument. Click one to hear it alone.
      </p>
      <p style={{ fontSize: "var(--text-xs)", margin: 0, color: "var(--color-text-muted)" }}>
        Chorus 2 · generator: generative · 2 credits
      </p>
      <p className="numeric" style={{ margin: 0 }}>
        01:12.4 / 04:00 · 118 BPM · F# minor
      </p>
    </div>
  ),
};
