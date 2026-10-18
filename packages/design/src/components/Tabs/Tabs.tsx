import { Tabs as RadixTabs } from "radix-ui";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

import { cx } from "../css.js";
import styles from "./Tabs.module.css";

export type TabsProps = ComponentPropsWithoutRef<typeof RadixTabs.Root>;

/**
 * Tabs for the Inspector and the History panel
 * ([07 §1](../../../../specs/07-song-canvas.md)). Radix supplies the roving tab focus and the
 * arrow-key movement; the active tab is marked with a rule as well as a colour, so the state
 * never depends on hue alone (11 §3).
 */
export function Tabs({ className, children, ...rest }: TabsProps) {
  return (
    <RadixTabs.Root className={cx(styles.root, className)} {...rest}>
      {children}
    </RadixTabs.Root>
  );
}

export interface TabsListProps {
  readonly children: ReactNode;
  /** Accessible name for the tab list, e.g. "Inspector". */
  readonly label?: string;
  readonly className?: string;
}

export function TabsList({ children, label, className }: TabsListProps) {
  return (
    <RadixTabs.List
      className={cx(styles.list, className)}
      {...(label === undefined ? {} : { "aria-label": label })}
    >
      {children}
    </RadixTabs.List>
  );
}

export interface TabsTriggerProps {
  readonly value: string;
  readonly children: ReactNode;
  readonly disabled?: boolean;
  readonly className?: string;
}

export function TabsTrigger({ value, children, disabled = false, className }: TabsTriggerProps) {
  return (
    <RadixTabs.Trigger className={cx(styles.trigger, className)} value={value} disabled={disabled}>
      {children}
    </RadixTabs.Trigger>
  );
}

export interface TabsContentProps {
  readonly value: string;
  readonly children: ReactNode;
  readonly className?: string;
}

export function TabsContent({ value, children, className }: TabsContentProps) {
  return (
    <RadixTabs.Content className={cx(styles.content, className)} value={value}>
      {children}
    </RadixTabs.Content>
  );
}
