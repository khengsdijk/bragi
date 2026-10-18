import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { VibeSlider } from "../VibeSlider.js";

function Harness({
  initial = 0,
  onValueCommit,
  detent,
}: {
  readonly initial?: number;
  readonly onValueCommit?: (value: number) => void;
  readonly detent?: number;
}) {
  const [value, setValue] = useState(initial);
  return (
    <VibeSlider
      value={value}
      label="Brightness"
      endLabels={["Darker", "Brighter"]}
      getValueText={(next) => (next === 0 ? "unchanged" : next > 0 ? "brighter" : "darker")}
      {...(detent === undefined ? {} : { detent })}
      onValueChange={setValue}
      {...(onValueCommit === undefined ? {} : { onValueCommit })}
    />
  );
}

function thumb(): HTMLElement {
  return screen.getByRole("slider", { name: "Brightness" });
}

function sliderRoot(container: HTMLElement): HTMLElement {
  const root = container.querySelectorAll('[data-orientation="horizontal"]')[0];
  if (root === undefined) throw new Error("slider root not found");
  return root as HTMLElement;
}

describe("VibeSlider", () => {
  it("is bipolar: −1 … 1 with 0 in the middle", () => {
    render(<Harness />);
    expect(thumb().getAttribute("aria-valuemin")).toBe("-1");
    expect(thumb().getAttribute("aria-valuemax")).toBe("1");
    expect(thumb().getAttribute("aria-valuenow")).toBe("0");
  });

  it("shows both end labels as the words, not the numbers (11 §5)", () => {
    render(<Harness />);
    expect(screen.getByText("Darker")).toBeTruthy();
    expect(screen.getByText("Brighter")).toBeTruthy();
  });

  it("reports words through aria-valuetext", () => {
    render(<Harness initial={0.5} />);
    expect(thumb().getAttribute("aria-valuetext")).toBe("brighter");
    expect(thumb().getAttribute("aria-valuenow")).toBe("0.5");
  });

  it("steps exactly onto the grid, and onto 0 exactly", () => {
    render(<Harness initial={-0.05} />);
    fireEvent.keyDown(thumb(), { key: "ArrowRight" });
    expect(thumb().getAttribute("aria-valuenow")).toBe("0");
    fireEvent.keyDown(thumb(), { key: "ArrowLeft" });
    expect(thumb().getAttribute("aria-valuenow")).toBe("-0.05");
    fireEvent.keyDown(thumb(), { key: "ArrowUp" });
    expect(thumb().getAttribute("aria-valuenow")).toBe("0");
    fireEvent.keyDown(thumb(), { key: "ArrowDown" });
    expect(thumb().getAttribute("aria-valuenow")).toBe("-0.05");
  });

  it("crosses zero from either side without skipping it", () => {
    render(<Harness initial={0.05} />);
    fireEvent.keyDown(thumb(), { key: "ArrowLeft" });
    expect(thumb().getAttribute("aria-valuenow")).toBe("0");
    fireEvent.keyDown(thumb(), { key: "ArrowRight" });
    expect(thumb().getAttribute("aria-valuenow")).toBe("0.05");
  });

  it("reaches the ends with Home and End, and jumps ten steps with PageUp/PageDown", () => {
    render(<Harness />);
    fireEvent.keyDown(thumb(), { key: "End" });
    expect(thumb().getAttribute("aria-valuenow")).toBe("1");
    fireEvent.keyDown(thumb(), { key: "PageDown" });
    expect(thumb().getAttribute("aria-valuenow")).toBe("0.5");
    fireEvent.keyDown(thumb(), { key: "PageUp" });
    expect(thumb().getAttribute("aria-valuenow")).toBe("1");
    fireEvent.keyDown(thumb(), { key: "Home" });
    expect(thumb().getAttribute("aria-valuenow")).toBe("-1");
  });

  it("resets to the middle with 0, Delete or Backspace", () => {
    for (const key of ["0", "Delete", "Backspace"]) {
      const { unmount } = render(<Harness initial={0.75} />);
      fireEvent.keyDown(thumb(), { key });
      expect(thumb().getAttribute("aria-valuenow"), key).toBe("0");
      unmount();
    }
  });

  it("commits a reset so it can be undone as one change", () => {
    const onValueCommit = vi.fn();
    render(<Harness initial={0.75} onValueCommit={onValueCommit} />);
    fireEvent.keyDown(thumb(), { key: "0" });
    expect(onValueCommit).toHaveBeenCalledWith(0);
  });

  it("leaves other keys to Radix", () => {
    const onValueCommit = vi.fn();
    render(<Harness initial={0.25} onValueCommit={onValueCommit} />);
    fireEvent.keyDown(thumb(), { key: "Tab" });
    expect(onValueCommit).not.toHaveBeenCalled();
    expect(thumb().getAttribute("aria-valuenow")).toBe("0.25");
  });

  it("detents the pointer to the middle, but not the keyboard", () => {
    const { container } = render(<Harness detent={0.1} />);
    const root = sliderRoot(container);
    root.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 200,
        height: 32,
        right: 200,
        bottom: 32,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    // 102 px along a 200 px track is +0.02 — inside the detent, so it snaps to the middle.
    fireEvent.pointerDown(root, { clientX: 102, pointerId: 1 });
    expect(thumb().getAttribute("aria-valuenow")).toBe("0");

    // 160 px is +0.6 — outside the detent, so the pointer value stands.
    fireEvent.pointerMove(root, { clientX: 160, pointerId: 1 });
    expect(thumb().getAttribute("aria-valuenow")).toBe("0.6");

    fireEvent.pointerUp(root, { pointerId: 1 });
    expect(thumb().getAttribute("aria-valuenow")).toBe("0.6");
  });

  it("keeps the keyboard usable after a pointer gesture", () => {
    const { container } = render(<Harness />);
    const root = sliderRoot(container);
    root.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 200, height: 32, toJSON: () => ({}) }) as DOMRect;
    fireEvent.pointerDown(root, { clientX: 100, pointerId: 1 });
    fireEvent.pointerUp(root, { pointerId: 1 });
    fireEvent.keyDown(thumb(), { key: "ArrowRight" });
    expect(thumb().getAttribute("aria-valuenow")).toBe("0.05");
  });
});
