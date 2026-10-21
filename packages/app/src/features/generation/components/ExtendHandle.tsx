/**
 * The extend handle on the song canvas (07 §4.2, 09 §4.2): a small button at each song edge that
 * opens "Make longer…" / "Add an intro…".
 *
 * The popover asks for the bar count (4, 8 or 16; 8 by default) and an optional prompt, then
 * `generate.extend`. The flow owns everything after Generate: the context render, the job, the
 * Audition bar and the accepted candidate. This component only holds the form and the two
 * triggers, which keeps the canvas and the palette on the same action.
 *
 * Both handles are DOM buttons over the canvas, not part of the Pixi scene, so they are in the
 * accessibility tree and reachable with Tab (11 §6).
 */
import { Button, Popover, PopoverClose, SegmentedControl } from "@bragi/design";
import { type ReactNode, useId, useState } from "react";
import { useStore } from "zustand";

import { t } from "../../../i18n/index.js";
import {
  DEFAULT_EXTEND_BARS,
  EXTEND_BARS,
  type ExtendBarCount,
  type ExtendDirection,
  type ExtendFlow,
  type WarmupStatus,
} from "../state/extend-flow.js";

export interface ExtendHandleProps {
  readonly flow: ExtendFlow;
  /** `disabled` hides the Generate option and says why (09 §5). */
  readonly warmup: WarmupStatus;
  /** The open popover, when the command palette opened one (`null` when none is open). */
  readonly open: ExtendDirection | null;
  readonly onOpenChange: (direction: ExtendDirection | null) => void;
}

/** Whether the flow is doing work the Generate button must not start twice. */
function busy(phase: string): boolean {
  return ["rendering", "uploading", "submitting", "generating"].includes(phase);
}

export function ExtendHandle({ flow, warmup, open, onOpenChange }: ExtendHandleProps): ReactNode {
  const state = useStore(flow.store, (value) => value);
  const disabled = warmup === "disabled";

  const trigger = (direction: ExtendDirection, label: string): ReactNode => {
    const isOpen = open === direction;
    return (
      <Popover
        open={isOpen}
        onOpenChange={(next) => onOpenChange(next ? direction : null)}
        label={label}
        side="top"
        align={direction === "forward" ? "end" : "start"}
        trigger={
          <Button
            variant="secondary"
            size="sm"
            title={disabled ? t("generation.extend.disabled.hint") : label}
            data-testid={`extend-handle-${direction}`}
          >
            <span aria-hidden="true">{direction === "forward" ? "⟶" : "⟵"}</span>
            <span>
              {t(
                direction === "forward"
                  ? "generation.extend.title.end"
                  : "generation.extend.title.start",
              )}
            </span>
          </Button>
        }
      >
        <ExtendForm
          direction={direction}
          flow={flow}
          disabled={disabled}
          message={state.phase === "failed" ? state.message : undefined}
          onDone={() => onOpenChange(null)}
        />
      </Popover>
    );
  };

  return (
    <div style={OVERLAY} data-testid="extend-handles">
      <div style={START}>{trigger("backward", t("generation.extend.handle.start"))}</div>
      <div style={END}>{trigger("forward", t("generation.extend.handle.end"))}</div>
    </div>
  );
}

interface ExtendFormProps {
  readonly direction: ExtendDirection;
  readonly flow: ExtendFlow;
  readonly disabled: boolean;
  readonly message?: string | undefined;
  readonly onDone: () => void;
}

function ExtendForm({ direction, flow, disabled, message, onDone }: ExtendFormProps): ReactNode {
  const phase = useStore(flow.store, (state) => state.phase);
  const [bars, setBars] = useState(String(DEFAULT_EXTEND_BARS));
  const [prompt, setPrompt] = useState("");
  const promptId = useId();
  const running = busy(phase);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void flow
          .start({
            direction,
            bars: Number(bars) as ExtendBarCount,
            ...(prompt.trim() === "" ? {} : { prompt: prompt.trim() }),
          })
          .then((started) => {
            if (started) onDone();
          });
      }}
      style={FORM}
    >
      {disabled ? (
        <p role="note" style={NOTE}>
          {t("generation.extend.disabled.hint")}
        </p>
      ) : null}
      <SegmentedControl
        label={t("generation.extend.bars")}
        value={bars}
        options={EXTEND_BARS.map((count) => ({
          value: String(count),
          label: t("generation.extend.bars.option", { bars: count }),
        }))}
        onChange={setBars}
      />
      <label htmlFor={promptId} style={LABEL}>
        <span>
          {t(
            direction === "forward" ? "generation.extend.prompt" : "generation.extend.prompt.intro",
          )}
        </span>
        <input
          id={promptId}
          type="text"
          value={prompt}
          maxLength={1000}
          onChange={(event) => setPrompt(event.target.value)}
          style={INPUT}
        />
      </label>
      {message === undefined ? null : (
        <p role="alert" data-testid="extend-error">
          {message}
        </p>
      )}
      <div style={ACTIONS}>
        <PopoverClose asChild>
          <Button type="button">{t("generation.extend.close")}</Button>
        </PopoverClose>
        <Button type="submit" variant="primary" disabled={disabled || running}>
          {t("generation.extend.generate")}
        </Button>
      </div>
    </form>
  );
}

const OVERLAY = {
  position: "absolute",
  inset: 0,
  pointerEvents: "none",
  zIndex: 2,
} as const;

const START = {
  position: "absolute",
  left: "var(--space-1)",
  top: "50%",
  transform: "translateY(-50%)",
  pointerEvents: "auto",
} as const;

const END = {
  position: "absolute",
  right: "var(--space-1)",
  top: "50%",
  transform: "translateY(-50%)",
  pointerEvents: "auto",
} as const;

const FORM = { display: "grid", gap: "var(--space-2)", minWidth: "16rem" } as const;
const LABEL = { display: "grid", gap: "var(--space-1)" } as const;
const ACTIONS = { display: "flex", justifyContent: "flex-end", gap: "var(--space-1)" } as const;
const NOTE = { margin: 0, color: "var(--color-text-muted)" } as const;
const INPUT = {
  padding: "var(--space-1) var(--space-2)",
  border: "1px solid var(--color-line-strong)",
  borderRadius: "var(--radius-sm)",
  background: "var(--color-surface)",
  color: "var(--color-text)",
} as const;
