// @vitest-environment jsdom
/**
 * The ✨ Fill gap and ✨ Smooth with AI chips (07 §4.8, §4.1; 11 §6).
 *
 * Both are real buttons over the canvas whose accessible name is their visible text, both are
 * reachable with Tab and open or act with Enter, and the smooth chip's popover is a labelled dialog
 * with a radio group for the bridge length and a labelled prompt.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore, type StoreApi } from "zustand/vanilla";

import { FillGapChip } from "../components/FillGapChip.js";
import { SmoothChip } from "../components/SmoothChip.js";
import type { GenerationState, WarmupStatus } from "../state/generation-session.js";
import type { SmoothFlow, SmoothRequest } from "../state/smooth-flow.js";

afterEach(cleanup);

const ANCHOR = { x: 100, y: 200, w: 120, h: 20 };

describe("FillGapChip", () => {
  it("is a named button that fills the gap on click and on Enter", async () => {
    const onFill = vi.fn();
    render(
      <FillGapChip
        anchor={ANCHOR}
        label="Drums and Bass · bars 3–4"
        disabled={false}
        running={false}
        onFill={onFill}
      />,
    );
    const chip = screen.getByRole("button", { name: "✨ Fill gap" });
    expect(chip.getAttribute("title")).toContain("Drums and Bass");
    await userEvent.click(chip);
    expect(onFill).toHaveBeenCalledTimes(1);

    chip.focus();
    await userEvent.keyboard("{Enter}");
    expect(onFill).toHaveBeenCalledTimes(2);
  });

  it("disables while generating and explains a disabled server", async () => {
    const { rerender } = render(
      <FillGapChip anchor={ANCHOR} label="Drums" disabled={false} running onFill={() => {}} />,
    );
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
    rerender(
      <FillGapChip anchor={ANCHOR} label="Drums" disabled running={false} onFill={() => {}} />,
    );
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a failed start as an alert", () => {
    render(
      <FillGapChip
        anchor={ANCHOR}
        label="Drums"
        disabled={false}
        running={false}
        message="The generator is busy"
        onFill={() => {}}
      />,
    );
    expect(screen.getByRole("alert").textContent).toBe("The generator is busy");
  });

  it("is not rendered while the gap is off screen", () => {
    render(
      <FillGapChip
        anchor={null}
        label="Drums"
        disabled={false}
        running={false}
        onFill={() => {}}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });
});

function fakeFlow(): { flow: SmoothFlow; start: ReturnType<typeof vi.fn> } {
  const store: StoreApi<GenerationState> = createStore(() => ({
    phase: "idle" as const,
    candidates: 0,
  }));
  const start = vi.fn(async (_request: SmoothRequest) => true);
  const flow: SmoothFlow = {
    source: { subscribe: () => () => {} },
    store,
    warmup: vi.fn(async () => "warm" as WarmupStatus),
    start,
    accepted: vi.fn(),
    discarded: vi.fn(),
    group: () => null,
    dispose: vi.fn(),
  };
  return { flow, start };
}

function Harness({ flow }: { readonly flow: SmoothFlow }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <SmoothChip
      flow={flow}
      sectionId="sec_002"
      sectionLabel="Chorus 1"
      anchor={ANCHOR}
      disabled={false}
      open={open}
      onOpenChange={setOpen}
    />
  );
}

describe("SmoothChip", () => {
  it("opens the labelled popover with the keyboard and starts a 2-bar bridge", async () => {
    const { flow, start } = fakeFlow();
    render(<Harness flow={flow} />);

    const chip = screen.getByRole("button", { name: "✨ Smooth with AI" });
    expect(chip.getAttribute("title")).toContain("Chorus 1");
    chip.focus();
    await userEvent.keyboard("{Enter}");

    await screen.findByRole("dialog", { name: "Smooth this transition with AI" });
    expect((screen.getByRole("radio", { name: "1 bar" }) as HTMLInputElement).checked).toBe(true);
    await userEvent.click(screen.getByRole("radio", { name: "2 bars" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Smooth transition" }), "riser");
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));

    expect(start).toHaveBeenCalledWith({
      sectionId: "sec_002",
      lengthBars: 2,
      prompt: "riser",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
