import { DropdownMenu as RadixMenu } from "radix-ui";
import type { ReactElement, ReactNode } from "react";

import { cx } from "../css.js";
import styles from "./Menu.module.css";

export interface MenuProps {
  /** The trigger. Must be a single element that forwards props (`asChild`). */
  readonly trigger: ReactElement;
  /** `MenuItem`, `MenuSeparator`, `MenuLabel` and friends. */
  readonly children: ReactNode;
  readonly label?: string;
  readonly open?: boolean;
  readonly defaultOpen?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly side?: "top" | "right" | "bottom" | "left";
  readonly align?: "start" | "center" | "end";
  readonly sideOffset?: number;
  /**
   * Modal menus hide the rest of the page from assistive tech while they are open. Set `false`
   * for a menu that should leave the page reachable.
   */
  readonly modal?: boolean;
  readonly className?: string;
}

/**
 * A styled Radix Dropdown Menu — the section context menu in
 * [07 §4.1](../../../../specs/07-song-canvas.md). Arrow keys, typeahead, Esc and the focus
 * return to the trigger all come from Radix.
 */
export function Menu({
  trigger,
  children,
  label,
  open,
  defaultOpen,
  onOpenChange,
  side = "bottom",
  align = "start",
  sideOffset = 4,
  modal = true,
  className,
}: MenuProps) {
  return (
    <RadixMenu.Root
      modal={modal}
      {...(open === undefined ? {} : { open })}
      {...(defaultOpen === undefined ? {} : { defaultOpen })}
      {...(onOpenChange === undefined ? {} : { onOpenChange })}
    >
      <RadixMenu.Trigger asChild>{trigger}</RadixMenu.Trigger>
      <RadixMenu.Portal>
        <RadixMenu.Content
          className={cx(styles.content, className)}
          side={side}
          align={align}
          sideOffset={sideOffset}
          {...(label === undefined ? {} : { "aria-label": label })}
        >
          {children}
        </RadixMenu.Content>
      </RadixMenu.Portal>
    </RadixMenu.Root>
  );
}

export interface MenuItemProps {
  readonly children: ReactNode;
  readonly onSelect?: () => void;
  readonly disabled?: boolean;
  readonly icon?: ReactNode;
  /** Display form of the keyboard shortcut, e.g. "⌘D". */
  readonly shortcut?: string;
  /** `danger` colours the item for destructive actions. */
  readonly tone?: "default" | "danger";
  readonly className?: string;
}

export function MenuItem({
  children,
  onSelect,
  disabled = false,
  icon,
  shortcut,
  tone = "default",
  className,
}: MenuItemProps) {
  return (
    <RadixMenu.Item
      className={cx(styles.item, className)}
      data-tone={tone}
      disabled={disabled}
      {...(onSelect === undefined ? {} : { onSelect })}
    >
      {icon === undefined ? null : (
        <span className={styles.itemIcon} aria-hidden="true">
          {icon}
        </span>
      )}
      <span className={styles.itemLabel}>{children}</span>
      {shortcut === undefined ? null : <span className={styles.shortcut}>{shortcut}</span>}
    </RadixMenu.Item>
  );
}

export function MenuSeparator() {
  return <RadixMenu.Separator className={styles.separator} />;
}

export function MenuLabel({ children }: { readonly children: ReactNode }) {
  return <RadixMenu.Label className={styles.groupLabel}>{children}</RadixMenu.Label>;
}

export interface MenuGroupProps {
  readonly children: ReactNode;
  readonly label?: string;
}

export function MenuGroup({ children, label }: MenuGroupProps) {
  return (
    <RadixMenu.Group {...(label === undefined ? {} : { "aria-label": label })}>
      {children}
    </RadixMenu.Group>
  );
}
