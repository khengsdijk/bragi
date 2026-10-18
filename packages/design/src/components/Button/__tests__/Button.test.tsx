import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Icon } from "../../Icon/Icon.js";
import { IconButton } from "../../IconButton/IconButton.js";
import { Button } from "../Button.js";

describe("Button", () => {
  it("renders its label and defaults to a secondary, medium button", () => {
    render(<Button>Play</Button>);
    const button = screen.getByRole("button", { name: "Play" });
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("data-variant")).toBe("secondary");
    expect(button.getAttribute("data-size")).toBe("md");
  });

  it("takes a variant and a size", () => {
    render(
      <Button variant="primary" size="lg">
        Export song
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Export song" });
    expect(button.getAttribute("data-variant")).toBe("primary");
    expect(button.getAttribute("data-size")).toBe("lg");
  });

  it("calls onClick", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Mute</Button>);
    await userEvent.click(screen.getByRole("button", { name: "Mute" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("cannot be clicked while disabled", async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Export song
      </Button>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Export song" }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("announces that it is busy while loading and cannot be pressed again", async () => {
    const onClick = vi.fn();
    render(
      <Button loading loadingLabel="Exporting" onClick={onClick}>
        Export song
      </Button>,
    );
    const button = screen.getByRole("button", { name: /Exporting|Export song/ });
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(true);
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("renders the child element with asChild", () => {
    render(
      <Button asChild variant="ghost">
        <a href="#song">Open song</a>
      </Button>,
    );
    const link = screen.getByRole("link", { name: "Open song" });
    expect(link.getAttribute("href")).toBe("#song");
    expect(link.getAttribute("data-variant")).toBe("ghost");
  });

  it("marks icons as decorative so the label is the accessible name", () => {
    render(<Button iconLeft={<span>♪</span>}>Play</Button>);
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
    expect(screen.getByText("♪").closest("[aria-hidden='true']")).not.toBeNull();
  });
});

describe("IconButton", () => {
  it("takes its accessible name from the required label", () => {
    render(
      <IconButton label="Close">
        <Icon>
          <path d="M4 4l8 8" />
        </Icon>
      </IconButton>,
    );
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  });

  it("is square and at least a 24 px target", () => {
    render(
      <IconButton label="Solo" size="sm">
        <Icon>
          <path d="M3 8h10" />
        </Icon>
      </IconButton>,
    );
    const button = screen.getByRole("button", { name: "Solo" });
    expect(button.getAttribute("data-icon-only")).toBe("true");
    expect(button.getAttribute("data-size")).toBe("sm");
  });

  it("shows its tooltip on hover", async () => {
    render(
      <IconButton label="Solo" tooltip="Hear this instrument alone">
        <Icon>
          <path d="M3 8h10" />
        </Icon>
      </IconButton>,
    );
    await userEvent.hover(screen.getByRole("button", { name: "Solo" }));
    expect((await screen.findAllByText("Hear this instrument alone")).length).toBeGreaterThan(0);
  });
});
