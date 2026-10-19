import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { SegmentedControl } from "../SegmentedControl.js";

const OPTIONS = [
  { value: "0", label: "Low-pass" },
  { value: "1", label: "High-pass" },
  { value: "2", label: "Band-pass" },
] as const;

describe("SegmentedControl", () => {
  it("is a named radio group with one option per segment", () => {
    render(<SegmentedControl label="Mode" value="0" options={OPTIONS} onChange={() => {}} />);
    expect(screen.getByRole("group", { name: "Mode" })).toBeTruthy();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect((screen.getByRole("radio", { name: "Low-pass" }) as HTMLInputElement).checked).toBe(
      true,
    );
  });

  it("reports the picked value", async () => {
    const onChange = vi.fn();
    render(<SegmentedControl label="Mode" value="0" options={OPTIONS} onChange={onChange} />);
    await userEvent.click(screen.getByRole("radio", { name: "Band-pass" }));
    expect(onChange).toHaveBeenCalledWith("2");
  });

  it("marks the chosen segment in more than colour", () => {
    const { container } = render(
      <SegmentedControl label="Mode" value="1" options={OPTIONS} onChange={() => {}} />,
    );
    const chosen = container.querySelector('[data-checked="true"]');
    expect(chosen?.textContent).toBe("High-pass");
  });
});
