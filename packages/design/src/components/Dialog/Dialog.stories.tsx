import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";

import { Button } from "../Button/Button.js";
import { Dialog, DialogClose } from "./Dialog.js";

const meta = {
  title: "Components/Dialog",
  component: Dialog,
  parameters: { layout: "centered" },
  args: {
    title: "Export song",
    description: "The mix is written as a 24-bit WAV file, with the stems in a folder beside it.",
    closeLabel: "Close",
    trigger: <Button variant="primary">Export song</Button>,
  },
} satisfies Meta<typeof Dialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Closed: Story = {
  args: {
    footer: <Button>Cancel</Button>,
  },
};

/** Rendered open, so axe scans the dialog's content too. */
export const Open: Story = {
  args: {
    defaultOpen: true,
    footer: (
      <>
        <DialogClose asChild>
          <Button>Cancel</Button>
        </DialogClose>
        <Button variant="primary">Export</Button>
      </>
    ),
    children: <p>Bragi will write the file to your Music folder.</p>,
  },
};

/** A plain warning dialog: one sentence, one choice. */
export const ConfirmRemove: Story = {
  args: {
    title: "Remove this section?",
    description: "You can undo this until you close the song.",
    defaultOpen: true,
    size: "sm",
    closeLabel: "Close",
    footer: (
      <>
        <DialogClose asChild>
          <Button>Cancel</Button>
        </DialogClose>
        <Button variant="danger">Remove</Button>
      </>
    ),
  },
};

function Controlled() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open again</Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Add more music"
        description="Bragi wants a few more songs before it can draw constellations."
        closeLabel="Close"
        footer={
          <DialogClose asChild>
            <Button>Later</Button>
          </DialogClose>
        }
      >
        <p>Drop files anywhere, or choose a folder.</p>
      </Dialog>
    </>
  );
}

/** Driven by the app rather than by a trigger. */
export const WithoutTrigger: Story = { render: () => <Controlled /> };
