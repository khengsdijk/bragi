import { render, screen } from "@testing-library/react";
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
});
