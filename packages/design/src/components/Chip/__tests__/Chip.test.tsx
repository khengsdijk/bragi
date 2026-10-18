import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Chip } from "../Chip.js";

describe("Chip", () => {
  it("is a plain label when it is not interactive", () => {
    render(<Chip>Half-time</Chip>);
    expect(screen.getByText("Half-time")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("becomes a button when it can be selected, and reports its pressed state", async () => {
    const onSelect = vi.fn();
    render(
      <Chip selected onSelect={onSelect}>
        More lo-fi
      </Chip>,
    );
    const chip = screen.getByRole("button", { name: "More lo-fi" });
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(chip);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("shows a role swatch while the text keeps the meaning (11 §3)", () => {
    const { container } = render(<Chip stemRole="vocals">Vocals</Chip>);
    const swatch = container.querySelector('[aria-hidden="true"]');
    expect(swatch).not.toBeNull();
    expect((swatch as HTMLElement).style.getPropertyValue("--swatch")).toBe("var(--role-vocals)");
    expect(screen.getByText("Vocals")).toBeTruthy();
  });

  it("paints a section chip in its family colour with the section label colour", () => {
    const { container } = render(<Chip sectionKind="pre_chorus">Pre-chorus</Chip>);
    const chip = container.firstElementChild as HTMLElement;
    expect(chip.getAttribute("data-section")).toBe("pre_chorus");
    expect(chip.style.getPropertyValue("--chip-fill")).toBe("var(--section-fill-warm)");
  });

  it("takes an accessible name when the visible label is abbreviated", () => {
    render(<Chip accessibleLabel="More spacious">Space+</Chip>);
    expect(screen.getByLabelText("More spacious")).toBeTruthy();
  });

  it("is at least a 24 px target when it is a button", () => {
    const { container } = render(<Chip onSelect={() => {}}>Quieter</Chip>);
    expect((container.firstElementChild as HTMLElement).className).toContain("chip");
  });
});
