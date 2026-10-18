import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { Button } from "../../Button/Button.js";
import { Tooltip, TooltipProvider } from "../Tooltip.js";

describe("Tooltip", () => {
  it("shows its content on hover and again on focus", async () => {
    render(
      <Tooltip content="Uses 2 credits">
        <Button>Clean up rough edges</Button>
      </Tooltip>,
    );
    const trigger = screen.getByRole("button", { name: "Clean up rough edges" });
    await userEvent.hover(trigger);
    expect(await screen.findByRole("tooltip")).toBeTruthy();

    await userEvent.unhover(trigger);
    await userEvent.tab();
    expect(trigger).toBe(document.activeElement);
    expect((await screen.findAllByRole("tooltip")).length).toBeGreaterThan(0);
  });

  it("works inside a provider, which is how an app mounts it", async () => {
    render(
      <TooltipProvider>
        <Tooltip content="Needs internet">
          <Button>Continue with AI</Button>
        </Tooltip>
      </TooltipProvider>,
    );
    await userEvent.hover(screen.getByRole("button", { name: "Continue with AI" }));
    expect(await screen.findByRole("tooltip")).toBeTruthy();
  });

  it("can be switched off without losing the trigger", () => {
    render(
      <Tooltip content="Not now" disabled>
        <Button>Disabled tooltip</Button>
      </Tooltip>,
    );
    expect(screen.getByRole("button", { name: "Disabled tooltip" })).toBeTruthy();
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});
