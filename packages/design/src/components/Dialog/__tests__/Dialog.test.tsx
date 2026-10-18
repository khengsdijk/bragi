import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { Button } from "../../Button/Button.js";
import { Dialog, DialogClose } from "../Dialog.js";

function ExportDialog({
  onOpenChange,
  withDescription = true,
}: {
  readonly onOpenChange?: (open: boolean) => void;
  readonly withDescription?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog
      trigger={<Button variant="primary">Export song</Button>}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        onOpenChange?.(next);
      }}
      title="Export song"
      {...(withDescription ? { description: "The mix is written as a 24-bit WAV file." } : {})}
      closeLabel="Close"
      footer={
        <>
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button variant="primary">Export</Button>
        </>
      }
    >
      <p>Where should it go?</p>
    </Dialog>
  );
}

describe("Dialog", () => {
  it("opens from its trigger and names itself with the title", async () => {
    render(<ExportDialog />);
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Export song" }));
    const dialog = await screen.findByRole("dialog", { name: "Export song" });
    expect(dialog).toBeTruthy();
    expect(screen.getByText("The mix is written as a 24-bit WAV file.")).toBeTruthy();
  });

  it("moves focus inside, traps it, and hands it back on close", async () => {
    render(<ExportDialog />);
    const trigger = screen.getByRole("button", { name: "Export song" });
    await userEvent.click(trigger);
    await screen.findByRole("dialog");
    const close = screen.getByRole("button", { name: "Close" });
    expect(document.activeElement).toBe(close);

    // Tab wraps inside the dialog rather than reaching the page behind it.
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Export" }));

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes from a footer action", async () => {
    const onOpenChange = vi.fn();
    render(<ExportDialog onOpenChange={onOpenChange} />);
    await userEvent.click(screen.getByRole("button", { name: "Export song" }));
    await screen.findByRole("dialog");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does not describe itself twice when there is no description", async () => {
    render(<ExportDialog withDescription={false} />);
    await userEvent.click(screen.getByRole("button", { name: "Export song" }));
    const dialog = await screen.findByRole("dialog", { name: "Export song" });
    expect(dialog.hasAttribute("aria-describedby")).toBe(false);
  });
});
