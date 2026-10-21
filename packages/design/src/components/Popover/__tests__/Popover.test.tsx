import { act, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { Button } from "../../Button/Button.js";
import { Popover } from "../Popover.js";

describe("Popover", () => {
  it("opens a labelled panel from its trigger", async () => {
    render(
      <Popover trigger={<Button>Make longer…</Button>} label="How should it get longer?">
        <p>Loop, stretch or continue with AI.</p>
      </Popover>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Make longer…" }));
    expect(await screen.findByRole("dialog", { name: "How should it get longer?" })).toBeTruthy();
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    render(
      <Popover trigger={<Button>Explain</Button>} label="Explain">
        <p>This section repeats the chorus.</p>
      </Popover>,
    );
    const trigger = screen.getByRole("button", { name: "Explain" });
    await userEvent.click(trigger);
    await screen.findByRole("dialog");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps its content in the DOM while open", async () => {
    render(
      <Popover trigger={<Button>Brushes</Button>} label="Brushes">
        <button type="button">Space</button>
      </Popover>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Brushes" }));
    expect(await screen.findByRole("button", { name: "Space" })).toBeTruthy();
  });

  it("stays open when focus moves outside, if asked to, but still closes on Escape", async () => {
    const closed: boolean[] = [];
    render(
      <>
        <button type="button">Canvas</button>
        <Popover
          open
          onOpenChange={(open) => closed.push(!open)}
          dismissOnFocusOutside={false}
          trigger={<Button>Explain</Button>}
          label="Explain"
        >
          <p>The drums drop out.</p>
        </Popover>
      </>,
    );
    await screen.findByRole("dialog");
    act(() => screen.getByRole("button", { name: "Canvas" }).focus());
    expect(closed).toEqual([]);
    await userEvent.keyboard("{Escape}");
    expect(closed).toEqual([true]);
  });

  it("closes when focus moves outside by default", async () => {
    const closed: boolean[] = [];
    render(
      <>
        <button type="button">Canvas</button>
        <Popover
          open
          onOpenChange={(open) => closed.push(!open)}
          trigger={<Button>Explain</Button>}
          label="Explain"
        >
          <p>The drums drop out.</p>
        </Popover>
      </>,
    );
    await screen.findByRole("dialog");
    act(() => screen.getByRole("button", { name: "Canvas" }).focus());
    expect(closed).toEqual([true]);
  });
});
