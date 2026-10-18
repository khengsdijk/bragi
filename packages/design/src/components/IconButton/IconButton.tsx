import type { ReactNode } from "react";

import { Button, type ButtonSize, type ButtonVariant } from "../Button/Button.js";
import { Tooltip } from "../Tooltip/Tooltip.js";

export interface IconButtonProps {
  /** Required: an icon alone has no accessible name. */
  readonly label: string;
  /** The glyph. Decorative — `label` is what assistive tech reads. */
  readonly children: ReactNode;
  /** Optional visible tooltip. Defaults to no tooltip; the label is never the only carrier. */
  readonly tooltip?: ReactNode;
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly side?: "top" | "right" | "bottom" | "left";
  readonly onClick?: () => void;
  readonly className?: string;
}

/**
 * A square button that carries only a glyph (11 §6.4: 24 × 24 px minimum target, 32 px by
 * default). The `label` prop is mandatory and becomes `aria-label`, so the icon is never the
 * only carrier of meaning.
 */
export function IconButton({
  label,
  children,
  tooltip,
  variant = "ghost",
  size = "md",
  disabled = false,
  loading = false,
  side = "top",
  onClick,
  className,
}: IconButtonProps) {
  const button = (
    <Button
      variant={variant}
      size={size}
      disabled={disabled}
      loading={loading}
      aria-label={label}
      {...(onClick === undefined ? {} : { onClick })}
      {...(className === undefined ? {} : { className })}
      data-icon-only="true"
    >
      {children}
    </Button>
  );

  if (tooltip === undefined) return button;

  return (
    <Tooltip content={tooltip} side={side} disabled={disabled}>
      {button}
    </Tooltip>
  );
}
