/**
 * "Explain this" output (06 §8, 07 §4.9): the grounded text in a popover anchored at the click,
 * with the canvas highlights drawn until it closes.
 *
 * The trigger is a visually hidden 1×1 button at the pointer, the same pattern as the section menu:
 * Radix needs an anchor, and the popover's `label` gives it an accessible name.
 */
import { Button, Popover } from "@bragi/design";
import type { ReactNode } from "react";

import { t } from "../../../i18n/index.js";
import type { ExplanationState } from "../state/planner.js";

export interface ExplainPopoverProps {
  readonly explanation: ExplanationState | null;
  readonly onClose: () => void;
}

export function ExplainPopover({ explanation, onClose }: ExplainPopoverProps): ReactNode {
  if (explanation === null) return null;
  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      side="bottom"
      align="start"
      label={t("planner.explainLabel")}
      // The click that opens it also focuses the canvas; that must not close it again.
      dismissOnFocusOutside={false}
      trigger={
        <Button
          variant="ghost"
          size="sm"
          tabIndex={-1}
          aria-hidden="true"
          aria-label={t("planner.explainLabel")}
          data-testid="explain-anchor"
          style={{
            position: "fixed",
            left: explanation.anchor.x,
            top: explanation.anchor.y,
            width: 1,
            height: 1,
            minWidth: 0,
            padding: 0,
            overflow: "hidden",
            opacity: 0,
            pointerEvents: "none",
            clipPath: "inset(50%)",
          }}
        >
          {t("planner.explainLabel")}
        </Button>
      }
    >
      <div
        data-testid="explain-popover"
        style={{
          display: "grid",
          gap: "var(--space-2)",
          maxWidth: 360,
          padding: "var(--space-1)",
        }}
      >
        {explanation.status === "waiting" ? (
          <p role="status" aria-live="polite" style={TEXT}>
            {t("planner.thinking")}
          </p>
        ) : explanation.status === "error" ? (
          <p role="alert" style={ERROR} data-testid="explain-error">
            {explanation.message}
          </p>
        ) : (
          <>
            <p style={TEXT} data-testid="explain-text">
              {explanation.text}
            </p>
            {explanation.learnMore !== null ? (
              <p style={MUTED} data-testid="explain-more">
                {explanation.learnMore}
              </p>
            ) : null}
          </>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <Button variant="ghost" size="sm" type="button" onClick={onClose}>
            {t("planner.explainClose")}
          </Button>
        </div>
      </div>
    </Popover>
  );
}

const TEXT = { margin: 0, fontSize: "var(--text-sm)", lineHeight: 1.5 } as const;
const MUTED = {
  margin: 0,
  fontSize: "var(--text-sm)",
  color: "var(--color-text-muted)",
} as const;
const ERROR = {
  margin: 0,
  fontSize: "var(--text-sm)",
  color: "var(--color-warning)",
} as const;
