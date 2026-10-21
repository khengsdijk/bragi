// @vitest-environment jsdom
import type { AuditionSlot } from "@bragi/platform";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";

import { AuditionBar } from "../components/AuditionBar.js";
import type { Audition, AuditionGroup, AuditionState } from "../state/audition.js";

afterEach(cleanup);

function fakeAudition(group: AuditionGroup, warm: AuditionState["warm"], moreLike = false) {
  const store = createStore<AuditionState>(() => ({ group, selected: 0, warm, busy: false }));
  const audition = {
    store,
    openCandidates: vi.fn(async () => true),
    openCompare: vi.fn(async () => true),
    setQueue: vi.fn(),
    select: vi.fn((slot: AuditionSlot) => {
      store.setState({ selected: slot });
      return true;
    }),
    accept: vi.fn(async () => true),
    discard: vi.fn(async () => {}),
    canMoreLike: () => moreLike,
    moreLike: vi.fn(),
    dispose: vi.fn(),
  } satisfies Audition;
  return audition;
}

const IDEAS: AuditionGroup = {
  id: "grp_ideas",
  kind: "candidates",
  prompt: "Half-time drums in Verse 2",
  candidates: [
    { id: "cmt_a", label: "Lo-fi only", slot: 1, status: { kind: "hq" }, doc: null },
    { id: "cmt_b", label: "Half-time feel", slot: 2, status: { kind: "preview" }, doc: null },
    {
      id: "cmt_c",
      label: "Stripped",
      slot: 3,
      status: { kind: "generating", pct: 0.42 },
      doc: null,
    },
  ],
};

describe("the Audition bar", () => {
  it("is a toolbar with the prompt, a chip per slot and status badges", () => {
    render(<AuditionBar audition={fakeAudition(IDEAS, [1, 2])} />);
    const bar = screen.getByRole("toolbar", { name: "Version ideas" });
    expect(bar.textContent).toContain("Half-time drums in Verse 2");
    expect(screen.getByTestId("audition-slot-0").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("audition-slot-1").textContent).toContain("Lo-fi onlyHQ");
    expect(screen.getByTestId("audition-slot-2").textContent).toContain("Preview");
    expect(screen.getByTestId("audition-slot-3").textContent).toContain("Generating 42%");
    // Not warm yet: it cannot be selected.
    expect((screen.getByTestId("audition-slot-3") as HTMLButtonElement).disabled).toBe(true);
    // Accept needs a candidate; "More like this" needs a source that can serve it.
    expect((screen.getByRole("button", { name: "Accept" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.queryByRole("button", { name: "More like this" })).toBeNull();
  });

  it("switches with 0–3, ignores typing, and accepts the selected idea", () => {
    const audition = fakeAudition(IDEAS, [1, 2], true);
    render(
      <>
        <input aria-label="Name" />
        <AuditionBar audition={audition} />
      </>,
    );
    fireEvent.keyDown(window, { key: "2" });
    expect(audition.select).toHaveBeenLastCalledWith(2);
    expect(screen.getByTestId("audition-slot-2").getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Name" }), { key: "1" });
    expect(audition.select).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "0" });
    expect(audition.select).toHaveBeenLastCalledWith(0);

    fireEvent.click(screen.getByTestId("audition-slot-1"));
    fireEvent.click(screen.getByRole("button", { name: "More like this" }));
    expect(audition.moreLike).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(audition.accept).toHaveBeenCalled();
  });

  it("moves focus along the toolbar with the arrow keys", () => {
    render(<AuditionBar audition={fakeAudition(IDEAS, [1, 2])} />);
    const original = screen.getByTestId("audition-slot-0");
    original.focus();
    fireEvent.keyDown(original, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByTestId("audition-slot-1"));
    fireEvent.keyDown(document.activeElement as Element, { key: "End" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Discard" }));
  });

  it("compares with A/B and closes on Escape", () => {
    const audition = fakeAudition(
      {
        id: "compare:a:b",
        kind: "compare",
        prompt: "Compare two versions",
        candidates: [
          { id: "cmt_a", label: "Imported song", slot: 1, status: { kind: "hq" }, doc: null },
          { id: "cmt_b", label: "Mute Drums", slot: 2, status: { kind: "hq" }, doc: null },
        ],
      },
      [1, 2],
    );
    render(<AuditionBar audition={audition} />);
    expect(screen.getByRole("toolbar", { name: "Compare versions" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    fireEvent.keyDown(window, { key: "b" });
    expect(audition.select).toHaveBeenLastCalledWith(2);
    fireEvent.keyDown(window, { key: "A" });
    expect(audition.select).toHaveBeenLastCalledWith(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(audition.discard).toHaveBeenCalled();
  });
});
