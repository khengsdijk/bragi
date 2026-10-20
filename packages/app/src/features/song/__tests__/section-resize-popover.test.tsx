// @vitest-environment jsdom
/**
 * The Loop/Stretch/Trim question after a right-edge drag (07 §4.2): an accessible dialog that
 * takes focus, closes on Escape and hands the chosen mode to the workspace.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SectionResizePopover } from "../components/SectionResizePopover.js";
import type { ResizePrompt } from "../hooks/use-section-drag.js";

afterEach(cleanup);

function prompt(bars: number, currentBars: number): ResizePrompt {
  return {
    sectionId: "sec_002",
    bars,
    currentBars,
    clientX: 240,
    clientY: 120,
    returnFocus: null,
  };
}

describe("section resize popover", () => {
  it("offers Loop and Stretch when the part grows, and focuses the first choice", async () => {
    const onChoose = vi.fn();
    render(<SectionResizePopover prompt={prompt(6, 4)} onClose={() => {}} onChoose={onChoose} />);
    expect(await screen.findByRole("dialog", { name: "Make this part longer" })).toBeTruthy();
    expect(screen.getByText("It will be 6 bars.")).toBeTruthy();
    const loop = screen.getByRole("button", { name: "Loop" });
    expect(screen.getByRole("button", { name: "Stretch" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(loop));
    await userEvent.click(screen.getByRole("button", { name: "Stretch" }));
    expect(onChoose).toHaveBeenCalledWith("stretch");
  });

  it("offers Trim when the part shrinks", async () => {
    const onChoose = vi.fn();
    render(<SectionResizePopover prompt={prompt(2, 4)} onClose={() => {}} onChoose={onChoose} />);
    expect(await screen.findByRole("dialog", { name: "Make this part shorter" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Loop" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Trim" }));
    expect(onChoose).toHaveBeenCalledWith("trim");
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(<SectionResizePopover prompt={prompt(6, 4)} onClose={onClose} onChoose={() => {}} />);
    await screen.findByRole("dialog");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
