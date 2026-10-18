import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { Button } from "../../Button/Button.js";
import { ToastProvider, useToast } from "../Toast.js";

function Demo({ onSelect }: { readonly onSelect?: () => void }) {
  const { toast, dismiss } = useToast();
  return (
    <div>
      <Button
        onClick={() =>
          toast({
            id: "analysis",
            title: "Analysis complete",
            description: "9 parts, 6 instruments found",
            tone: "success",
            duration: 0,
            action: { label: "Show parts", onSelect: () => onSelect?.() },
          })
        }
      >
        Analyse
      </Button>
      <Button
        onClick={() =>
          toast({ title: "We couldn't find chords in this song", tone: "danger", duration: 0 })
        }
      >
        Fail
      </Button>
      <Button onClick={() => dismiss()}>Clear</Button>
    </div>
  );
}

function Harness({ onSelect }: { readonly onSelect?: () => void }) {
  return (
    <ToastProvider label="Notifications" closeLabel="Dismiss">
      <Demo {...(onSelect === undefined ? {} : { onSelect })} />
    </ToastProvider>
  );
}

describe("Toast", () => {
  it("shows a toast in a labelled region and announces it politely", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Analyse" }));
    expect(await screen.findByText("Analysis complete")).toBeTruthy();
    expect(screen.getByText("9 parts, 6 instruments found")).toBeTruthy();
    expect(screen.getByRole("region", { name: /Notifications/ })).toBeTruthy();
    await waitFor(() => {
      const live = screen.getAllByRole("status");
      expect(
        live.some((element) => (element.textContent ?? "").includes("Analysis complete")),
      ).toBe(true);
      expect(live.every((element) => element.getAttribute("aria-live") === "polite")).toBe(true);
    });
  });

  it("uses an assertive live region for errors (11 §8)", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Fail" }));
    expect(await screen.findByText("We couldn't find chords in this song")).toBeTruthy();
    await waitFor(() => {
      const live = screen.getAllByRole("status");
      expect(live.some((element) => element.getAttribute("aria-live") === "assertive")).toBe(true);
    });
  });

  it("dismisses from its close button", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Analyse" }));
    await screen.findByText("Analysis complete");
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => {
      expect(screen.queryByText("Analysis complete")).toBeNull();
    });
  });

  it("runs an action", async () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    await userEvent.click(screen.getByRole("button", { name: "Analyse" }));
    await userEvent.click(await screen.findByRole("button", { name: "Show parts" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("clears everything at once", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Analyse" }));
    await userEvent.click(screen.getByRole("button", { name: "Fail" }));
    expect(screen.getByText("Analysis complete")).toBeTruthy();
    expect(screen.getByText("We couldn't find chords in this song")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => {
      expect(screen.queryByText("Analysis complete")).toBeNull();
      expect(screen.queryByText("We couldn't find chords in this song")).toBeNull();
    });
  });

  it("refuses to be used outside its provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Demo />)).toThrow(/ToastProvider/);
    spy.mockRestore();
  });
});

/** The controller is stable across renders, so a toast callback can be held in state. */
function StableController() {
  const { toast } = useToast();
  const [message, setMessage] = useState("");
  return (
    <Button
      onClick={() => {
        setMessage("Kept");
        toast({ title: "Kept", duration: 0 });
      }}
    >
      {message === "" ? "Notify" : message}
    </Button>
  );
}

describe("useToast", () => {
  it("keeps the controller stable between renders", async () => {
    render(
      <ToastProvider label="Notifications" closeLabel="Dismiss">
        <StableController />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Notify" }));
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Kept" })).toBeTruthy();
  });
});
