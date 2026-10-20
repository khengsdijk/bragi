// @vitest-environment jsdom
/**
 * The small rename / type / length dialogs (07 §4.1–4.2). Each one edits a local value and hands
 * the result to the workspace action on submit; the document itself is only changed through the
 * batch in `section-ops`.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SectionActionDialogs } from "../components/SectionActionDialogs.js";
import type { SectionDialog } from "../hooks/use-song-actions.js";

afterEach(cleanup);

function renderDialog(
  dialog: SectionDialog,
  handlers: {
    readonly onRename?: (sectionId: string, label: string) => void;
    readonly onChangeKind?: (sectionId: string, kind: string) => void;
    readonly onResize?: (sectionId: string, bars: number, mode: string) => void;
  } = {},
) {
  return render(
    <SectionActionDialogs
      dialog={dialog}
      onClose={() => {}}
      onRename={handlers.onRename ?? (() => {})}
      onChangeKind={(id, kind) => handlers.onChangeKind?.(id, kind)}
      onResize={(id, bars, mode) => handlers.onResize?.(id, bars, mode)}
    />,
  );
}

describe("section action dialogs", () => {
  it("renames a part and refuses an empty name", async () => {
    const onRename = vi.fn();
    renderDialog({ kind: "rename", sectionId: "sec_001", label: "Verse 1" }, { onRename });
    const field = screen.getByRole("textbox", { name: "Part name" });
    expect((field as HTMLInputElement).value).toBe("Verse 1");
    await userEvent.clear(field);
    expect((screen.getByRole("button", { name: "Save name" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await userEvent.type(field, "Intro verse");
    await userEvent.click(screen.getByRole("button", { name: "Save name" }));
    expect(onRename).toHaveBeenCalledWith("sec_001", "Intro verse");
  });

  it("changes the part type", async () => {
    const onChangeKind = vi.fn();
    renderDialog(
      { kind: "changeKind", sectionId: "sec_001", sectionKind: "verse" },
      { onChangeKind },
    );
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Type" }), "chorus");
    await userEvent.click(screen.getByRole("button", { name: "Change type" }));
    expect(onChangeKind).toHaveBeenCalledWith("sec_001", "chorus");
  });

  it("makes a part longer with a bar count and Loop or Stretch", async () => {
    const onResize = vi.fn();
    renderDialog(
      {
        kind: "resize",
        sectionId: "sec_002",
        direction: "longer",
        mode: "loop",
        bars: 8,
        currentBars: 4,
      },
      { onResize },
    );
    const bars = screen.getByRole("spinbutton", { name: "Bars" });
    await userEvent.clear(bars);
    await userEvent.type(bars, "6");
    await userEvent.click(screen.getByRole("radio", { name: "Stretch" }));
    await userEvent.click(screen.getByRole("button", { name: "Change length" }));
    expect(onResize).toHaveBeenCalledWith("sec_002", 6, "stretch");
  });

  it("makes a part shorter with Trim and blocks the unchanged length", async () => {
    const onResize = vi.fn();
    renderDialog(
      {
        kind: "resize",
        sectionId: "sec_002",
        direction: "shorter",
        mode: "trim",
        bars: 4,
        currentBars: 4,
      },
      { onResize },
    );
    expect(screen.getByText("How: Trim")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Change length" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    const bars = screen.getByRole("spinbutton", { name: "Bars" });
    await userEvent.clear(bars);
    await userEvent.type(bars, "3");
    await userEvent.click(screen.getByRole("button", { name: "Change length" }));
    expect(onResize).toHaveBeenCalledWith("sec_002", 3, "trim");
  });
});
