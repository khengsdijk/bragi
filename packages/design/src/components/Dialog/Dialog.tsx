import { Dialog as RadixDialog } from "radix-ui";
import type { ReactElement, ReactNode } from "react";

import { cx } from "../css.js";
import { Icon } from "../Icon/Icon.js";
import { IconButton } from "../IconButton/IconButton.js";
import styles from "./Dialog.module.css";

export interface DialogProps {
  /** Optional trigger; omit it to drive `open` from the app (e.g. a menu item or a shortcut). */
  readonly trigger?: ReactElement;
  readonly open?: boolean;
  readonly defaultOpen?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  /** The dialog's heading. Required: a dialog must announce what it is. */
  readonly title: string;
  readonly description?: string;
  readonly children?: ReactNode;
  /** Buttons, usually `DialogClose`-driven. */
  readonly footer?: ReactNode;
  /** Accessible name for the close button. */
  readonly closeLabel: string;
  readonly size?: "sm" | "md" | "lg";
  readonly className?: string;
}

/**
 * A styled Radix Dialog: modal, focus-trapped, Esc closes and focus returns to the trigger.
 *
 * The title is always rendered (Radix needs it for the accessible name); when there is no
 * description Radix is told so explicitly, instead of announcing the title twice.
 */
export function Dialog({
  trigger,
  open,
  defaultOpen,
  onOpenChange,
  title,
  description,
  children,
  footer,
  closeLabel,
  size = "md",
  className,
}: DialogProps) {
  return (
    <RadixDialog.Root
      {...(open === undefined ? {} : { open })}
      {...(defaultOpen === undefined ? {} : { defaultOpen })}
      {...(onOpenChange === undefined ? {} : { onOpenChange })}
    >
      {trigger === undefined ? null : <RadixDialog.Trigger asChild>{trigger}</RadixDialog.Trigger>}
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={styles.overlay} />
        <RadixDialog.Content
          className={cx(styles.content, className)}
          data-size={size}
          {...(description === undefined ? { "aria-describedby": undefined } : {})}
        >
          <div className={styles.header}>
            <RadixDialog.Title className={styles.title}>{title}</RadixDialog.Title>
            <RadixDialog.Close asChild>
              <IconButton label={closeLabel} size="sm">
                <Icon>
                  <path d="M4 4l8 8M12 4l-8 8" />
                </Icon>
              </IconButton>
            </RadixDialog.Close>
          </div>
          {description === undefined ? null : (
            <RadixDialog.Description className={styles.description}>
              {description}
            </RadixDialog.Description>
          )}
          {children === undefined ? null : <div className={styles.body}>{children}</div>}
          {footer === undefined ? null : <div className={styles.footer}>{footer}</div>}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/** Closes the dialog from inside its content (Radix `Close`). */
export const DialogClose = RadixDialog.Close;
