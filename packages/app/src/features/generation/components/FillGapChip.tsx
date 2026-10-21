/**
 * The floating ✨ Fill gap chip after an erase (07 §4.8).
 *
 * It is a DOM button over the canvas, anchored to the erased region with the renderer's own box
 * (`regionRect`), so it sits next to the gap at any zoom and is in the accessibility tree. Its
 * accessible name is its visible text ("✨ Fill gap"); the title names the region it fills.
 */
import { Button } from "@bragi/design";
import type { ReactNode } from "react";

import { t } from "../../../i18n/index.js";

export interface ChipBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface FillGapChipProps {
  /** The gap's box on the canvas; `null` while it is off screen. */
  readonly anchor: ChipBox | null;
  /** "Drums and Bass · bars 9–12". */
  readonly label: string;
  readonly disabled: boolean;
  readonly running: boolean;
  readonly message?: string | undefined;
  readonly onFill: () => void;
}

export function FillGapChip({
  anchor,
  label,
  disabled,
  running,
  message,
  onFill,
}: FillGapChipProps): ReactNode {
  if (anchor === null) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: Math.max(8, anchor.x + anchor.w / 2),
        top: Math.max(8, anchor.y - 8),
        transform: "translate(-50%, -100%)",
        pointerEvents: "auto",
        zIndex: 3,
      }}
    >
      <Button
        variant="secondary"
        size="sm"
        data-testid="fill-gap-chip"
        title={t("generation.fill.chipTitle", { label })}
        {...(message === undefined ? {} : { "aria-describedby": "fill-gap-message" })}
        disabled={disabled || running}
        onClick={onFill}
      >
        {t("generation.fill.chip")}
      </Button>
      {message === undefined ? null : (
        <p
          id="fill-gap-message"
          role="alert"
          data-testid="fill-gap-error"
          style={{
            margin: "var(--space-1) 0 0",
            padding: "var(--space-1) var(--space-2)",
            background: "var(--color-surface)",
            border: "1px solid var(--color-line-strong)",
            borderRadius: "var(--radius-sm)",
          }}
        >
          {message}
        </p>
      )}
    </div>
  );
}
