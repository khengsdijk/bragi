// @vitest-environment jsdom
/**
 * The extend handle and its "Make longer…" popover (07 §4.2, 09 §4.2, 11 §6).
 *
 * Both triggers are real buttons with names, the panel is a labelled dialog, the bar count is a
 * radio group and the prompt a labelled text box, so the form is reachable and readable with a
 * keyboard and a screen reader. `start` is the only thing the component asks the flow to do.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore, type StoreApi } from "zustand/vanilla";
import { ExtendHandle } from "../components/ExtendHandle.js";
import type { ExtendFlow, ExtendRequest, ExtendState, WarmupStatus } from "../state/extend-flow.js";

afterEach(cleanup);

function fakeFlow(state: ExtendState = { phase: "idle", candidates: 0 }) {
  const store: StoreApi<ExtendState> = createStore(() => state);
  const start = vi.fn(async (_request: ExtendRequest) => true);
  const flow: ExtendFlow = {
    source: { subscribe: () => () => {} },
    store,
    warmup: vi.fn(async () => "warm" as WarmupStatus),
    start,
    accepted: vi.fn(),
    discarded: vi.fn(),
    dispose: vi.fn(),
  };
  return { flow, store, start };
}

function Harness({
  flow,
  warmup = "warm",
}: {
  readonly flow: ExtendFlow;
  readonly warmup?: WarmupStatus;
}): ReactNode {
  const [open, setOpen] = useState<null | "forward" | "backward">(null);
  return <ExtendHandle flow={flow} warmup={warmup} open={open} onOpenChange={setOpen} />;
}

describe("ExtendHandle", () => {
  it("opens the labelled popover from the end handle with a keyboard", async () => {
    const { flow, start } = fakeFlow();
    render(<Harness flow={flow} />);

    const trigger = screen.getByRole("button", { name: "Make the song longer with AI" });
    trigger.focus();
    await userEvent.keyboard("{Enter}");

    const dialog = await screen.findByRole("dialog", { name: "Make the song longer with AI" });
    expect(dialog).toBeTruthy();
    expect((screen.getByRole("radio", { name: "8 bars" }) as HTMLInputElement).checked).toBe(true);

    await userEvent.click(screen.getByRole("radio", { name: "16 bars" }));
    expect((screen.getByRole("radio", { name: "16 bars" }) as HTMLInputElement).checked).toBe(true);
    await userEvent.type(
      screen.getByRole("textbox", { name: "What should happen next?" }),
      "dreamy outro",
    );
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));

    expect(start).toHaveBeenCalledWith({ direction: "forward", bars: 16, prompt: "dreamy outro" });
    // A successful start closes the popover, because the Audition bar takes over.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers an intro popover at the start handle", async () => {
    const { flow, start } = fakeFlow();
    render(<Harness flow={flow} />);
    await userEvent.click(screen.getByRole("button", { name: "Add an intro with AI" }));
    await screen.findByRole("dialog", { name: "Add an intro with AI" });
    expect(screen.getByRole("textbox", { name: "What should happen first?" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect(start).toHaveBeenCalledWith({ direction: "backward", bars: 8 });
  });

  it("disables Generate and says why when the server has no generator", async () => {
    const { flow } = fakeFlow();
    render(<Harness flow={flow} warmup="disabled" />);
    await userEvent.click(screen.getByRole("button", { name: "Make the song longer with AI" }));
    await screen.findByRole("dialog");
    expect(screen.getByRole("note").textContent).toBe(
      "Extending needs the generation worker; this server has none",
    );
    expect((screen.getByRole("button", { name: "Generate" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("shows a failed start as an alert and stays open", async () => {
    const { flow } = fakeFlow({ phase: "failed", candidates: 0, message: "The generator is busy" });
    render(<Harness flow={flow} />);
    await userEvent.click(screen.getByRole("button", { name: "Make the song longer with AI" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("The generator is busy");
  });
});
