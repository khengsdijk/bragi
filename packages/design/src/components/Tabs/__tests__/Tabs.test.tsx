import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "../Tabs.js";

function Inspector() {
  return (
    <Tabs defaultValue="inspector">
      <TabsList label="Right panel">
        <TabsTrigger value="inspector">Inspector</TabsTrigger>
        <TabsTrigger value="chat">Chat</TabsTrigger>
        <TabsTrigger value="history" disabled>
          History
        </TabsTrigger>
      </TabsList>
      <TabsContent value="inspector">Vibe sliders live here</TabsContent>
      <TabsContent value="chat">Ask for a change</TabsContent>
      <TabsContent value="history">Versions</TabsContent>
    </Tabs>
  );
}

describe("Tabs", () => {
  it("exposes a labelled tab list with the first tab selected", () => {
    render(<Inspector />);
    expect(screen.getByRole("tablist", { name: "Right panel" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Inspector" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByRole("tabpanel").textContent).toBe("Vibe sliders live here");
  });

  it("moves between tabs with the arrow keys", async () => {
    render(<Inspector />);
    screen.getByRole("tab", { name: "Inspector" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Chat" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").textContent).toBe("Ask for a change");
  });

  it("selects a tab when it is clicked", async () => {
    render(<Inspector />);
    await userEvent.click(screen.getByRole("tab", { name: "Chat" }));
    expect(screen.getByRole("tab", { name: "Chat" }).getAttribute("aria-selected")).toBe("true");
  });

  it("skips a disabled tab", async () => {
    render(<Inspector />);
    const history = screen.getByRole("tab", { name: "History" });
    expect((history as HTMLButtonElement).disabled).toBe(true);
    // Looping past the last selectable tab wraps back to the first, not into the disabled one.
    screen.getByRole("tab", { name: "Chat" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Inspector" }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("links each tab to its panel", () => {
    render(<Inspector />);
    const tab = screen.getByRole("tab", { name: "Inspector" });
    const panel = screen.getByRole("tabpanel");
    expect(tab.getAttribute("aria-controls")).toBe(panel.getAttribute("id"));
    expect(panel.getAttribute("aria-labelledby")).toBe(tab.getAttribute("id"));
  });
});
