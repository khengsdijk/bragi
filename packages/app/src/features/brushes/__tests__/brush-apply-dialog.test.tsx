// @vitest-environment jsdom
/**
 * "Apply brush…" (11 §6.2): the keyboard path defaults to every instrument in the part, and the
 * filter sweep only shows its direction when that brush is chosen.
 */
import type { SectionInstance } from "@bragi/schemas";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BrushApplyDialog, type BrushApplyResult } from "../components/BrushApplyDialog.js";

afterEach(cleanup);

// Radix's Slider measures its thumb; jsdom has no ResizeObserver.
if (!("ResizeObserver" in globalThis)) {
  Object.defineProperty(globalThis, "ResizeObserver", {
    writable: true,
    configurable: true,
    value: class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  });
}

const SECTION: SectionInstance = {
  id: "sec_001",
  kind: "verse",
  label: "Verse 1",
  lengthTicks: 15_360,
  lanes: {
    trk_drums: { clips: [], automation: [] },
    trk_bass: { clips: [], automation: [] },
  },
  transitionIn: { kind: "cut", lengthTicks: 0 },
};

const TRACKS = [
  { id: "trk_drums", name: "Drums" },
  { id: "trk_bass", name: "Bass" },
];

function renderDialog(overrides: { readonly onApply?: (result: BrushApplyResult) => void } = {}) {
  const onApply = overrides.onApply ?? vi.fn();
  render(
    <BrushApplyDialog
      section={SECTION}
      tracks={TRACKS}
      brush="space"
      strength={0.5}
      direction="up"
      onClose={() => {}}
      onApply={onApply}
    />,
  );
  return onApply;
}

describe("BrushApplyDialog", () => {
  it("applies the current brush to every instrument by default", async () => {
    const onApply = renderDialog();
    expect(screen.getByRole("checkbox", { name: "Drums" })).toHaveProperty("checked", true);
    expect(screen.getByRole("checkbox", { name: "Bass" })).toHaveProperty("checked", true);
    await userEvent.click(screen.getByRole("button", { name: "Apply brush" }));
    expect(onApply).toHaveBeenCalledWith({
      brush: "space",
      trackIds: ["trk_drums", "trk_bass"],
      strength: 0.5,
      direction: "up",
    });
  });

  it("lets the user narrow the instruments and choose another brush", async () => {
    const onApply = renderDialog();
    await userEvent.click(screen.getByRole("checkbox", { name: "Bass" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Brush" }), "louder");
    await userEvent.click(screen.getByRole("button", { name: "Apply brush" }));
    expect(onApply).toHaveBeenCalledWith({
      brush: "louder",
      trackIds: ["trk_drums"],
      strength: 0.5,
      direction: "up",
    });
  });

  it("shows the sweep direction only for Filter sweep", async () => {
    renderDialog();
    expect(screen.queryByRole("radio", { name: "Rising" })).toBeNull();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Brush" }), "filterSweep");
    expect(screen.getByRole("radio", { name: "Rising" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Falling" })).toBeTruthy();
  });

  it("cannot apply with no instruments selected", async () => {
    renderDialog();
    await userEvent.click(screen.getByRole("checkbox", { name: "Drums" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "Bass" }));
    expect(
      (screen.getByRole("button", { name: "Apply brush" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
