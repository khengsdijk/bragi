import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect } from "react";

import { Button } from "../Button/Button.js";
import { ToastProvider, useToast } from "./Toast.js";

const meta = {
  title: "Components/Toast",
  component: ToastProvider,
  parameters: { layout: "centered" },
  args: { children: null, label: "Notifications", closeLabel: "Dismiss" },
} satisfies Meta<typeof ToastProvider>;

export default meta;
type Story = StoryObj<typeof meta>;

function Notifier() {
  const { toast } = useToast();
  return (
    <div className="story-row">
      <Button
        variant="primary"
        onClick={() =>
          toast({
            title: "Analysis complete",
            description: "9 parts, 6 instruments found",
            tone: "success",
            duration: 0,
          })
        }
      >
        Analysis complete
      </Button>
      <Button
        onClick={() =>
          toast({
            title: "We couldn't find chords in this song",
            description: "The parts are still here, so you can keep editing.",
            tone: "danger",
            duration: 0,
            action: { label: "Details", onSelect: () => {} },
          })
        }
      >
        Error
      </Button>
      <Button
        onClick={() =>
          toast({
            title: "3 version ideas ready",
            description: "Playing idea 1",
            duration: 0,
            action: { label: "Undo", onSelect: () => {} },
          })
        }
      >
        Version ideas
      </Button>
    </div>
  );
}

export const Interactive: Story = {
  render: () => (
    <ToastProvider label="Notifications" closeLabel="Dismiss">
      <Notifier />
    </ToastProvider>
  ),
};

function AutoOpen({ tone }: { readonly tone: "success" | "danger" | "" }) {
  const { toast } = useToast();
  useEffect(() => {
    toast({
      title: tone === "danger" ? "We couldn't reach the server" : "Analysis complete",
      description:
        tone === "danger"
          ? "Editing and playback still work. We'll try again shortly."
          : "9 parts, 6 instruments found",
      ...(tone === "" ? {} : { tone }),
      duration: 0,
      action: { label: "Details", onSelect: () => {} },
    });
    // Once, so the scan sees a toast.
  }, [toast, tone]);
  return <p>Notifications appear bottom-right.</p>;
}

/** Rendered open, so axe scans the toast's content too. */
export const Open: Story = {
  render: () => (
    <ToastProvider label="Notifications" closeLabel="Dismiss">
      <AutoOpen tone="" />
    </ToastProvider>
  ),
};

export const ErrorOpen: Story = {
  render: () => (
    <ToastProvider label="Notifications" closeLabel="Dismiss">
      <AutoOpen tone="danger" />
    </ToastProvider>
  ),
};
