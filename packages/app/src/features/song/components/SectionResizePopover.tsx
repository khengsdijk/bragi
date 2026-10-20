/**
 * "How should it get longer/shorter?" after a right-edge drag (07 §4.2).
 *
 * The drag itself changes nothing; this popover is where the mode is chosen and the one
 * `section.resize` batch is committed. Loop and Stretch are offered when the part grows, Trim
 * when it shrinks. The ✨ Continue with AI and ✨ Condense choices arrive with WP-2.7.
 */
import { Button, Popover } from "@bragi/design";
import type { SectionResizeMode } from "@bragi/schemas";
import type { ReactNode } from "react";

import { type MessageKey, t } from "../../../i18n/index.js";
import type { ResizePrompt } from "../hooks/use-section-drag.js";

export interface SectionResizePopoverProps {
  readonly prompt: ResizePrompt | null;
  readonly onClose: () => void;
  readonly onChoose: (mode: SectionResizeMode) => void;
}

export function SectionResizePopover({
  prompt,
  onClose,
  onChoose,
}: SectionResizePopoverProps): ReactNode {
  if (prompt === null) return null;
  const longer = prompt.bars > prompt.currentBars;
  const modes: readonly SectionResizeMode[] = longer ? ["loop", "stretch"] : ["trim"];
  const title = t(longer ? "song.resize.longerTitle" : "song.resize.shorterTitle");

  return (
    <Popover
      open
      modal
      label={title}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      trigger={
        <Button
          variant="ghost"
          size="sm"
          tabIndex={-1}
          aria-hidden="true"
          data-testid="section-resize-anchor"
          style={{
            position: "fixed",
            left: prompt.clientX,
            top: prompt.clientY,
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
          {title}
        </Button>
      }
    >
      <div style={{ display: "grid", gap: "var(--space-2)", maxWidth: "22rem" }}>
        <p style={{ margin: 0, fontWeight: 600 }}>{title}</p>
        <p style={HINT_STYLE}>{t(longer ? "song.resize.longerHint" : "song.resize.shorterHint")}</p>
        <p style={HINT_STYLE}>{t("song.resize.result", { bars: prompt.bars })}</p>
        <fieldset
          aria-label={t("song.resize.how")}
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "var(--space-1)",
            margin: 0,
            padding: 0,
            border: 0,
            minWidth: 0,
          }}
        >
          {modes.map((mode, index) => (
            <Button
              key={mode}
              variant={index === 0 ? "primary" : "secondary"}
              size="sm"
              autoFocus={index === 0}
              onClick={() => onChoose(mode)}
            >
              {t(`song.resize.option.${mode}` as MessageKey)}
            </Button>
          ))}
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t("song.resize.cancel")}
          </Button>
        </fieldset>
      </div>
    </Popover>
  );
}

const HINT_STYLE = {
  margin: 0,
  color: "var(--color-text-muted)",
  fontSize: "var(--text-xs)",
} as const;
