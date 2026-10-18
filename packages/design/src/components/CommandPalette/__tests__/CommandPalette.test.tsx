import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { CommandPalette, type CommandPaletteItem } from "../CommandPalette.js";

const ITEMS: readonly CommandPaletteItem[] = [
  { id: "undo", label: "Undo", group: "Edit", hint: "⌘Z", keywords: ["revert"] },
  { id: "redo", label: "Redo", group: "Edit", hint: "⇧⌘Z" },
  { id: "solo", label: "Solo the hovered instrument", group: "Playback" },
  { id: "spread", label: "More spacious", group: "Vibe", keywords: ["reverb", "dry"] },
  { id: "export", label: "Export song", group: "Song" },
  { id: "delete", label: "Delete section", group: "Song", disabled: true },
];

function Harness({
  onSelect = () => {},
  items = ITEMS,
}: {
  readonly onSelect?: (item: CommandPaletteItem) => void;
  readonly items?: readonly CommandPaletteItem[];
}) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open commands
      </button>
      <CommandPalette
        open={open}
        onOpenChange={setOpen}
        items={items}
        onSelect={onSelect}
        label="Commands"
        placeholder="Type a command"
        emptyLabel="No matching commands"
      />
    </>
  );
}

describe("CommandPalette", () => {
  it("is a combobox driving a listbox of options", async () => {
    render(<Harness />);
    const input = screen.getByRole("combobox", { name: "Commands" });
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(input.getAttribute("aria-autocomplete")).toBe("list");
    const list = screen.getByRole("listbox", { name: "Commands" });
    expect(input.getAttribute("aria-controls")).toBe(list.getAttribute("id"));
    expect(screen.getAllByRole("option").length).toBe(ITEMS.length);
  });

  it("highlights the first option and points aria-activedescendant at it", () => {
    render(<Harness />);
    const input = screen.getByRole("combobox", { name: "Commands" });
    const first = screen.getByRole("option", { name: /Undo/ });
    expect(input.getAttribute("aria-activedescendant")).toBe(first.getAttribute("id"));
    expect(first.getAttribute("aria-selected")).toBe("true");
  });

  it("filters on the label and on keywords, case-insensitively", async () => {
    render(<Harness />);
    const input = screen.getByRole("combobox", { name: "Commands" });
    await userEvent.type(input, "reverb");
    expect(screen.getAllByRole("option").length).toBe(1);
    expect(screen.getByRole("option", { name: /More spacious/ })).toBeTruthy();

    await userEvent.clear(input);
    await userEvent.type(input, "solo");
    expect(screen.getByRole("option", { name: /Solo the hovered instrument/ })).toBeTruthy();
  });

  it("requires every word to match", async () => {
    render(<Harness />);
    await userEvent.type(screen.getByRole("combobox", { name: "Commands" }), "export song");
    expect(screen.getAllByRole("option").length).toBe(1);
  });

  it("shows the empty state when nothing matches", async () => {
    render(<Harness />);
    await userEvent.type(screen.getByRole("combobox", { name: "Commands" }), "zzz");
    expect(screen.getByText("No matching commands")).toBeTruthy();
    expect(screen.queryAllByRole("option").length).toBe(0);
  });

  it("moves with the arrow keys, skipping disabled options, and selects with Enter", async () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "solo" }));
  });

  it("wraps around at the ends and supports Home/End", async () => {
    render(<Harness />);
    const input = screen.getByRole("combobox", { name: "Commands" });
    await userEvent.keyboard("{ArrowUp}");
    // The disabled last item is skipped, so wrapping lands on "Export song".
    expect(input.getAttribute("aria-activedescendant")).toContain("export");
    await userEvent.keyboard("{Home}");
    expect(input.getAttribute("aria-activedescendant")).toContain("undo");
    await userEvent.keyboard("{End}");
    expect(input.getAttribute("aria-activedescendant")).toContain("export");
  });

  it("closes on Escape without choosing anything", async () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("closes when an option is chosen, after reporting it", async () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    await userEvent.click(screen.getByRole("option", { name: /Export song/ }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "export" }));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("never chooses a disabled option", async () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    const disabled = screen.getByRole("option", { name: /Delete section/ });
    expect(disabled.getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(disabled);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("focuses the search field when it opens", async () => {
    render(<Harness />);
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Commands" }));
  });

  it("forgets the query when it reopens", async () => {
    render(<Harness />);
    await userEvent.type(screen.getByRole("combobox", { name: "Commands" }), "solo");
    expect(screen.getAllByRole("option").length).toBe(1);
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Open commands" }));
    const input = screen.getByRole("combobox", { name: "Commands" });
    expect((input as HTMLInputElement).value).toBe("");
    expect(screen.getAllByRole("option").length).toBe(ITEMS.length);
  });
});
