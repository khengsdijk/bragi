import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Button } from "../../Button/Button.js";
import { Menu, MenuGroup, MenuItem, MenuLabel, MenuSeparator } from "../Menu.js";

function SectionMenu({ onSelect }: { readonly onSelect: (action: string) => void }) {
  return (
    <Menu trigger={<Button>Section actions</Button>} label="Section actions">
      <MenuGroup label="Edit">
        <MenuItem shortcut="⌘D" onSelect={() => onSelect("duplicate")}>
          Duplicate
        </MenuItem>
        <MenuItem onSelect={() => onSelect("rename")}>Rename</MenuItem>
      </MenuGroup>
      <MenuSeparator />
      <MenuItem tone="danger" onSelect={() => onSelect("remove")}>
        Remove
      </MenuItem>
      <MenuLabel>Regenerate</MenuLabel>
      <MenuItem disabled onSelect={() => onSelect("regenerate")}>
        Regenerate…
      </MenuItem>
    </Menu>
  );
}

describe("Menu", () => {
  it("opens from its trigger and lists the items", async () => {
    render(<SectionMenu onSelect={() => {}} />);
    expect(screen.queryByRole("menu")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Section actions" }));
    expect(await screen.findByRole("menu", { name: "Section actions" })).toBeTruthy();
    expect(screen.getAllByRole("menuitem").length).toBe(4);
    expect(screen.getAllByRole("separator").length).toBe(1);
  });

  it("marks the destructive item as dangerous", async () => {
    render(<SectionMenu onSelect={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "Section actions" }));
    const remove = await screen.findByRole("menuitem", { name: "Remove" });
    expect(remove.getAttribute("data-tone")).toBe("danger");
  });

  it("reaches items with the arrow keys and chooses with Enter", async () => {
    const onSelect = vi.fn();
    render(<SectionMenu onSelect={onSelect} />);
    await userEvent.click(screen.getByRole("button", { name: "Section actions" }));
    await screen.findByRole("menu");

    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(onSelect).toHaveBeenCalledWith("rename");
  });

  it("closes on Escape and hands focus back to the trigger", async () => {
    render(<SectionMenu onSelect={() => {}} />);
    const trigger = screen.getByRole("button", { name: "Section actions" });
    await userEvent.click(trigger);
    await screen.findByRole("menu");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("skips disabled items", async () => {
    const onSelect = vi.fn();
    render(<SectionMenu onSelect={onSelect} />);
    await userEvent.click(screen.getByRole("button", { name: "Section actions" }));
    const disabled = await screen.findByRole("menuitem", { name: "Regenerate…" });
    expect(disabled.getAttribute("data-disabled")).toBe("");
  });
});
