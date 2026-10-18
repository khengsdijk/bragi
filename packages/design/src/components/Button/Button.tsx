import { Slot } from "radix-ui";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

import { cx } from "../css.js";
import styles from "./Button.module.css";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends Omit<ComponentPropsWithoutRef<"button">, "children"> {
  /** The visible label. Every user-facing string is a prop: the app supplies the copy. */
  readonly children: ReactNode;
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  /** Renders the child element instead of a `<button>` (Radix `Slot`). */
  readonly asChild?: boolean;
  readonly iconLeft?: ReactNode;
  readonly iconRight?: ReactNode;
  /** Shows a spinner and marks the button busy. Not supported with `asChild`. */
  readonly loading?: boolean;
  /**
   * Spoken while `loading`. Usually unnecessary: `aria-busy` already tells assistive tech that
   * the label it can read is in progress.
   */
  readonly loadingLabel?: string;
}

/**
 * The one button. Variants differ only in colour; size, focus ring and disabled treatment are
 * shared. Every user-facing string arrives as a prop — the copy lives in the app's i18n (11 §2).
 *
 * With `asChild` the button renders its child instead of a `<button>`: `children` must be a
 * single element (usually a router `<Link>`), and the icons, spinner and label wrapping are the
 * caller's responsibility.
 */
export function Button({
  children,
  variant = "secondary",
  size = "md",
  asChild = false,
  iconLeft,
  iconRight,
  loading = false,
  loadingLabel,
  className,
  disabled = false,
  type = "button",
  ...rest
}: ButtonProps) {
  const busy = loading && !asChild;
  const classNames = cx(styles.button, className);

  const shared = {
    className: classNames,
    "data-variant": variant,
    "data-size": size,
    ...(loading ? { "data-loading": "true" as const } : {}),
  };

  if (asChild) {
    return (
      <Slot.Root {...rest} {...shared} aria-disabled={disabled || busy ? "true" : undefined}>
        {children}
      </Slot.Root>
    );
  }

  return (
    <button
      {...rest}
      {...shared}
      type={type}
      disabled={disabled || busy}
      aria-busy={busy ? "true" : undefined}
    >
      {busy ? <span className={styles.spinner} aria-hidden="true" /> : null}
      {busy && loadingLabel !== undefined ? (
        <span className={styles.srOnly}>{loadingLabel}</span>
      ) : null}
      {iconLeft === undefined ? null : (
        <span className={styles.icon} aria-hidden="true">
          {iconLeft}
        </span>
      )}
      <span
        className={styles.label}
        aria-hidden={busy && loadingLabel !== undefined ? "true" : undefined}
      >
        {children}
      </span>
      {iconRight === undefined ? null : (
        <span className={styles.icon} aria-hidden="true">
          {iconRight}
        </span>
      )}
    </button>
  );
}
