import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { Slider } from "../Slider.js";

function Harness({
  initial = 0.5,
  onValueChange,
  formatValue,
  showValue = false,
}: {
  readonly initial?: number;
  readonly onValueChange?: (value: number) => void;
  readonly formatValue?: (value: number) => string;
  readonly showValue?: boolean;
}) {
  const [value, setValue] = useState(initial);
  return (
    <Slider
      value={value}
      min={0}
      max={1}
      step={0.01}
      label="Volume"
      showValue={showValue}
      {...(formatValue === undefined ? {} : { formatValue })}
      onValueChange={(next) => {
        setValue(next);
        onValueChange?.(next);
      }}
    />
  );
}

describe("Slider", () => {
  it("exposes itself as a slider with its range and label", () => {
    render(<Harness />);
    const thumb = screen.getByRole("slider", { name: "Volume" });
    expect(thumb.getAttribute("aria-valuemin")).toBe("0");
    expect(thumb.getAttribute("aria-valuemax")).toBe("1");
    expect(thumb.getAttribute("aria-valuenow")).toBe("0.5");
    expect(thumb.getAttribute("aria-orientation")).toBe("horizontal");
  });

  it("steps with the arrow keys and jumps with PageUp/PageDown", () => {
    render(<Harness />);
    const thumb = screen.getByRole("slider", { name: "Volume" });
    fireEvent.keyDown(thumb, { key: "ArrowRight" });
    expect(thumb.getAttribute("aria-valuenow")).toBe("0.51");
    fireEvent.keyDown(thumb, { key: "PageUp" });
    expect(thumb.getAttribute("aria-valuenow")).toBe("0.61");
    fireEvent.keyDown(thumb, { key: "PageDown" });
    fireEvent.keyDown(thumb, { key: "ArrowLeft" });
    expect(thumb.getAttribute("aria-valuenow")).toBe("0.5");
  });

  it("goes to the ends with Home and End", () => {
    render(<Harness />);
    const thumb = screen.getByRole("slider", { name: "Volume" });
    fireEvent.keyDown(thumb, { key: "Home" });
    expect(thumb.getAttribute("aria-valuenow")).toBe("0");
    fireEvent.keyDown(thumb, { key: "End" });
    expect(thumb.getAttribute("aria-valuenow")).toBe("1");
  });

  it("reports a formatted value, and only shows numbers when asked", () => {
    const { unmount } = render(<Harness formatValue={(value) => `${value.toFixed(2)} dB`} />);
    let thumb = screen.getByRole("slider", { name: "Volume" });
    expect(thumb.getAttribute("aria-valuetext")).toBe("0.50 dB");
    expect(screen.queryByText("0.50 dB")).toBeNull(); // Simple mode: no numbers on screen (11 §5)
    unmount();

    render(<Harness formatValue={(value) => `${value.toFixed(2)} dB`} showValue />);
    thumb = screen.getByRole("slider", { name: "Volume" });
    expect(screen.getByText("0.50 dB")).toBeTruthy();
  });

  it("fires onValueCommit when a key press finishes", () => {
    const onValueChange = vi.fn();
    render(<Harness onValueChange={onValueChange} />);
    fireEvent.keyDown(screen.getByRole("slider", { name: "Volume" }), { key: "ArrowRight" });
    expect(onValueChange).toHaveBeenCalled();
  });

  it("can be disabled", () => {
    render(<Slider value={0.5} label="Volume" disabled onValueChange={() => {}} />);
    const thumb = screen.getByRole("slider", { name: "Volume" });
    expect(thumb.getAttribute("data-disabled")).toBe("");
    expect(thumb.getAttribute("tabindex")).toBeNull();
  });
});
