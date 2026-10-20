// @vitest-environment jsdom
/**
 * The section context menu (07 §4.1, 11 §6.2): the same commands as the palette, with the
 * "Smooth new joins" setting in its footer.
 */
import type { SectionInstance } from "@bragi/schemas";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CommandActions, CommandContext } from "../../commands/state/commands.js";
import { SONG_COMMANDS } from "../../commands/state/song-commands.js";
import { SectionMenu } from "../components/SectionMenu.js";

// Radix menu uses pointer capture and scrollIntoView; jsdom has neither.
if (!("hasPointerCapture" in Element.prototype)) {
  Object.defineProperty(Element.prototype, "hasPointerCapture", {
    writable: true,
    configurable: true,
    value: () => true,
  });
}
for (const method of ["setPointerCapture", "releasePointerCapture"] as const) {
  if (!(method in Element.prototype)) {
    Object.defineProperty(Element.prototype, method, {
      writable: true,
      configurable: true,
      value: () => {},
    });
  }
}
if (!("scrollIntoView" in Element.prototype)) {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    writable: true,
    configurable: true,
    value: () => {},
  });
}

afterEach(cleanup);

const SECTION: SectionInstance = {
  id: "sec_002",
  kind: "chorus",
  label: "Chorus 1",
  lengthTicks: 15_360,
  lanes: {},
  transitionIn: { kind: "cut", lengthTicks: 0 },
};

function actions(): CommandActions {
  return {
    moveSection: vi.fn(),
    duplicateSection: vi.fn(),
    removeSection: vi.fn(),
    openRename: vi.fn(),
    openKind: vi.fn(),
    setLocked: vi.fn(),
    loopSection: vi.fn(),
    openResize: vi.fn(),
    openBrush: vi.fn(),
    splitAtPlayhead: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    toggleHistory: vi.fn(),
    togglePlay: vi.fn(),
    askAi: vi.fn(),
    toggleExplain: vi.fn(),
  };
}

function context(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    section: SECTION,
    sectionIndex: 2,
    sectionCount: 5,
    sectionBars: 4,
    smartTransitions: true,
    canUndo: true,
    canRedo: false,
    hasHistory: true,
    historyOpen: false,
    playing: false,
    explainMode: false,
    actions: actions(),
    ...overrides,
  };
}

interface HarnessProps {
  readonly ctx: CommandContext;
  readonly onClose: () => void;
  readonly onSmartTransitionsChange: (value: boolean) => void;
  readonly returnFocus: HTMLElement;
}

/** Like the workspace: closing the menu removes its anchor, so Radix unmounts the content. */
function Harness({ ctx, onClose, onSmartTransitionsChange, returnFocus }: HarnessProps): ReactNode {
  const [open, setOpen] = useState(true);
  return (
    <SectionMenu
      anchor={open ? { x: 40, y: 60, returnFocus } : null}
      onClose={() => {
        setOpen(false);
        onClose();
      }}
      commands={SONG_COMMANDS}
      context={ctx}
      smartTransitions={ctx.smartTransitions}
      onSmartTransitionsChange={onSmartTransitionsChange}
    />
  );
}

function renderMenu(
  ctx: CommandContext,
  options: {
    readonly onClose?: () => void;
    readonly onSmartTransitionsChange?: (value: boolean) => void;
    readonly returnFocus?: HTMLElement;
  } = {},
) {
  const returnFocus = options.returnFocus ?? document.createElement("button");
  if (returnFocus.parentElement === null) document.body.append(returnFocus);
  return render(
    <Harness
      ctx={ctx}
      onClose={options.onClose ?? (() => {})}
      onSmartTransitionsChange={options.onSmartTransitionsChange ?? (() => {})}
      returnFocus={returnFocus}
    />,
  );
}

describe("SectionMenu", () => {
  it("lists the 07 §4.1 actions in order and the smoothing setting", async () => {
    const ctx = context();
    renderMenu(ctx);
    expect(await screen.findByRole("menu", { name: "Part actions" })).toBeTruthy();
    expect(
      screen.getAllByRole("menuitem").map((item) => item.querySelector("span")?.textContent),
    ).toEqual([
      "Duplicate part",
      "Remove part",
      "Rename part…",
      "Change type…",
      "Lock part from AI",
      "Loop this part",
      "Make part longer…",
      "Make part shorter…",
      "Apply brush…",
      "Ask AI…",
      "Explain this part",
    ]);
    const smooth = screen.getByRole("menuitemcheckbox", { name: "Smooth new joins" });
    expect(smooth.getAttribute("aria-checked")).toBe("true");
  });

  it("runs a command and closes the menu", async () => {
    const onClose = vi.fn();
    const ctx = context();
    renderMenu(ctx, { onClose });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Duplicate part" }));
    await waitFor(() => expect(ctx.actions.duplicateSection).toHaveBeenCalledWith("sec_002"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("offers Unlock for a locked part and toggles the setting", async () => {
    const onSmartTransitionsChange = vi.fn();
    const ctx = context({ section: { ...SECTION, locked: true } });
    renderMenu(ctx, { onSmartTransitionsChange });
    expect(await screen.findByRole("menuitem", { name: "Unlock part" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Lock part from AI" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Smooth new joins" }));
    expect(onSmartTransitionsChange).toHaveBeenCalledWith(false);
  });

  it("closes on Escape and returns focus to the element that opened it", async () => {
    const onClose = vi.fn();
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    renderMenu(context(), { onClose, returnFocus: trigger });
    await screen.findByRole("menu");
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("disables the part actions when no part is focused", async () => {
    renderMenu(context({ section: null, sectionIndex: -1 }));
    const duplicate = await screen.findByRole("menuitem", { name: "Duplicate part" });
    expect(duplicate.getAttribute("data-disabled")).toBe("");
  });
});
