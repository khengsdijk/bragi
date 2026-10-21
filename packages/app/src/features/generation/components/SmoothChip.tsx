/**
 * The ✨ Smooth with AI chip on a moved/removed boundary (07 §4.1, 09 §4.4).
 *
 * The chip is anchored at the boundary; it opens a labelled popover with the bridge length (1 or 2
 * bars, default 1) and an optional prompt, then the transition flow renders both sides and streams
 * candidates into the Audition bar. A DOM control over the canvas, so it is keyboard reachable and
 * its accessible name is its visible text.
 */
import { Button, Popover, PopoverClose, SegmentedControl } from "@bragi/design";
import { type ReactNode, useId, useState } from "react";
import { useStore } from "zustand";

import { t } from "../../../i18n/index.js";
import {
  DEFAULT_SMOOTH_BARS,
  SMOOTH_BARS,
  type SmoothBarCount,
  type SmoothFlow,
} from "../state/smooth-flow.js";
import type { ChipBox } from "./FillGapChip.js";

export interface SmoothChipProps {
  readonly flow: SmoothFlow;
  readonly sectionId: string;
  readonly sectionLabel: string;
  /** The boundary's box; `null` while it is off screen. */
  readonly anchor: ChipBox | null;
  readonly disabled: boolean;
  /** Controlled by the workspace so the command palette can open the same popover. */
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

function busy(phase: string): boolean {
  return ["rendering", "uploading", "submitting", "generating"].includes(phase);
}

export function SmoothChip({
  flow,
  sectionId,
  sectionLabel,
  anchor,
  disabled,
  open,
  onOpenChange,
}: SmoothChipProps): ReactNode {
  const phase = useStore(flow.store, (state) => state.phase);
  const message = useStore(flow.store, (state) => state.message);
  const [bars, setBars] = useState(String(DEFAULT_SMOOTH_BARS));
  const [prompt, setPrompt] = useState("");
  const promptId = useId();
  if (anchor === null) return null;

  const title = t("generation.smooth.chipTitle", { label: sectionLabel });
  return (
    <div
      style={{
        position: "absolute",
        left: Math.max(8, anchor.x + anchor.w / 2),
        top: Math.max(8, anchor.y - 6),
        transform: "translate(-50%, -100%)",
        pointerEvents: "auto",
        zIndex: 3,
      }}
    >
      <Popover
        open={open}
        onOpenChange={onOpenChange}
        label={t("generation.smooth.dialog")}
        side="top"
        align="center"
        trigger={
          <Button
            variant="secondary"
            size="sm"
            title={title}
            data-testid={`smooth-chip-${sectionId}`}
            data-section-id={sectionId}
            disabled={disabled}
          >
            {t("generation.smooth.chip")}
          </Button>
        }
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void flow
              .start({
                sectionId,
                lengthBars: Number(bars) as SmoothBarCount,
                ...(prompt.trim() === "" ? {} : { prompt: prompt.trim() }),
              })
              .then((started) => {
                if (started) onOpenChange(false);
              });
          }}
          style={{ display: "grid", gap: "var(--space-2)", minWidth: "16rem" }}
        >
          <SegmentedControl
            label={t("generation.smooth.bars")}
            value={bars}
            options={SMOOTH_BARS.map((count) => ({
              value: String(count),
              label: t(
                count === 1 ? "generation.smooth.bars.option" : "generation.smooth.bars.option.other",
                { bars: count },
              ),
            }))}
            onChange={setBars}
          />
          <label htmlFor={promptId} style={{ display: "grid", gap: "var(--space-1)" }}>
            <span>{t("generation.smooth.prompt")}</span>
            <input
              id={promptId}
              type="text"
              value={prompt}
              maxLength={1000}
              onChange={(event) => setPrompt(event.target.value)}
              style={{
                padding: "var(--space-1) var(--space-2)",
                border: "1px solid var(--color-line-strong)",
                borderRadius: "var(--radius-sm)",
                background: "var(--color-surface)",
                color: "var(--color-text)",
              }}
            />
          </label>
          {phase === "failed" && message !== undefined ? (
            <p role="alert">{message}</p>
          ) : null}
          <div
            style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-1)" }}
          >
            <PopoverClose asChild>
              <Button type="button">{t("generation.smooth.close")}</Button>
            </PopoverClose>
            <Button type="submit" variant="primary" disabled={disabled || busy(phase)}>
              {t("generation.smooth.generate")}
            </Button>
          </div>
        </form>
      </Popover>
    </div>
  );
}
