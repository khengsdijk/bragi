import { Popover as RadixPopover } from "radix-ui";
import type { ReactElement, ReactNode } from "react";

import { cx } from "../css.js";
import styles from "./Popover.module.css";

export interface PopoverProps {
  /** The trigger. Must be a single element that forwards props (`asChild`). */
  readonly trigger: ReactElement;
  readonly children: ReactNode;
  /** Accessible name for the popover. Required: the panel needs to announce what it is. */
  readonly label: string;
  readonly open?: boolean;
  readonly defaultOpen?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly side?: "top" | "right" | "bottom" | "left";
  readonly align?: "start" | "center" | "end";
  readonly sideOffset?: number;
  readonly alignOffset?: number;
  /** Modal popovers trap focus and block outside interaction. */
  readonly modal?: boolean;
  /**
   * Whether focus moving outside closes the popover (default true). Turn it off for a popover
   * opened by a click on a control that takes focus itself, such as the canvas in Explain mode:
   * that focus change would otherwise close it at once. Outside clicks and Esc still close it.
   */
  readonly dismissOnFocusOutside?: boolean;
  readonly className?: string;
}

/**
 * A styled Radix Popover: a small panel anchored to a control (the section right-click menu,
 * the extend popover in [07 §4.2](../../../../specs/07-song-canvas.md), "Explain" output).
 * Radix keeps the focus management and the Esc/outside-click behaviour.
 */
export function Popover({
  trigger,
  children,
  label,
  open,
  defaultOpen,
  onOpenChange,
  side = "bottom",
  align = "start",
  sideOffset = 6,
  alignOffset = 0,
  modal = false,
  dismissOnFocusOutside = true,
  className,
}: PopoverProps) {
  return (
    <RadixPopover.Root
      {...(open === undefined ? {} : { open })}
      {...(defaultOpen === undefined ? {} : { defaultOpen })}
      {...(onOpenChange === undefined ? {} : { onOpenChange })}
      modal={modal}
    >
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          className={cx(styles.content, className)}
          side={side}
          align={align}
          sideOffset={sideOffset}
          alignOffset={alignOffset}
          role="dialog"
          aria-label={label}
          {...(dismissOnFocusOutside ? {} : { onFocusOutside: (event) => event.preventDefault() })}
        >
          {children}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}

/** Closes the popover from inside its content (Radix `Close`). */
export const PopoverClose = RadixPopover.Close;
