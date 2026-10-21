// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";

import { PromptBar } from "../components/PromptBar.js";
import type { PlannerController, PlannerState } from "../state/planner.js";

afterEach(cleanup);

function fakePlanner(overrides: Partial<PlannerState> = {}) {
  const store = createStore<PlannerState>(() => ({
    open: true,
    phase: "idle",
    prompt: "",
    target: {
      region: { startTick: 1920, endTick: 5760, tracks: ["trk_drums"] },
      startSec: 1,
      endSec: 3,
      trackIds: ["trk_drums"],
      label: "Drums · bars 2–3",
      wholeSong: false,
      chips: ["planner.chip.halfTime", "planner.chip.quieter"],
    },
    interpretation: null,
    notices: [],
    clarification: null,
    message: null,
    candidates: 0,
    explanation: null,
    ...overrides,
  }));
  const planner = {
    store,
    openRegion: vi.fn(),
    openForSelection: vi.fn(),
    openForLasso: vi.fn(),
    setPrompt: vi.fn((prompt: string) => store.setState({ prompt })),
    submit: vi.fn(async () => {}),
    chooseClarification: vi.fn(async () => {}),
    cancel: vi.fn(),
    close: vi.fn(),
    explainAt: vi.fn(async () => {}),
    closeExplanation: vi.fn(),
    dispose: vi.fn(),
  } satisfies PlannerController;
  return planner;
}

describe("the prompt bar", () => {
  it("is a labelled dialog with the target, the field and local chips", () => {
    render(<PromptBar planner={fakePlanner()} anchor={null} />);
    const dialog = screen.getByRole("dialog", { name: "Ask AI" });
    expect(dialog.getAttribute("aria-describedby")).not.toBeNull();
    expect(screen.getByTestId("planner-target").textContent).toBe("Drums · bars 2–3");
    expect(screen.getByRole("textbox", { name: "What should change?" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Half-time" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Quieter" })).toBeTruthy();
  });

  it("submits a chip and the typed prompt", () => {
    const planner = fakePlanner();
    render(<PromptBar planner={planner} anchor={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Half-time" }));
    expect(planner.submit).toHaveBeenLastCalledWith("Half-time");

    fireEvent.change(screen.getByRole("textbox", { name: "What should change?" }), {
      target: { value: "make it warmer" },
    });
    expect(planner.setPrompt).toHaveBeenLastCalledWith("make it warmer");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "What should change?" }), {
      key: "Enter",
    });
    expect(planner.submit).toHaveBeenCalledTimes(2);
  });

  it("announces a busy state and lets the user cancel", () => {
    const planner = fakePlanner({ phase: "waiting", prompt: "warmer" });
    render(<PromptBar planner={planner} anchor={null} />);
    expect(screen.getByTestId("prompt-bar").querySelector("form")?.getAttribute("aria-busy")).toBe(
      "true",
    );
    expect(screen.getByTestId("planner-thinking").textContent).toBe("Thinking…");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(planner.cancel).toHaveBeenCalled();
  });

  it("shows the interpretation, notices and a clarification with its options", () => {
    const planner = fakePlanner({
      phase: "clarify",
      interpretation: "I'll calm the chorus.",
      notices: ["I described the artist as a warm synth."],
      clarification: {
        question: "Which direction?",
        options: ["Calmer", "Bigger"],
      },
    });
    render(<PromptBar planner={planner} anchor={null} />);
    expect(screen.getByTestId("planner-interpretation").textContent).toContain("calm the chorus");
    expect(screen.getByTestId("planner-notices").textContent).toContain("warm synth");
    fireEvent.click(screen.getByRole("button", { name: "Calmer" }));
    expect(planner.chooseClarification).toHaveBeenCalledWith("Calmer");
  });

  it("shows a plain error as an alert", () => {
    render(
      <PromptBar
        planner={fakePlanner({
          phase: "error",
          message: "The AI planner isn't set up on this computer yet.",
        })}
        anchor={null}
      />,
    );
    expect(screen.getByRole("alert").textContent).toBe(
      "The AI planner isn't set up on this computer yet.",
    );
  });
});
