/**
 * The prompt bar (07 §4.3): a labelled text field, local suggestion chips, a busy state while the
 * planner thinks, and the planner's interpretation, notices or clarification.
 *
 * It is a non-modal dialog anchored to the lasso/selection by the workspace from the renderer's
 * coordinates. Escape closes it (and aborts a request in flight), Enter submits, and the field is
 * focused when it opens, so the whole path is keyboard reachable (11 §6.2).
 */
import { Button, Chip } from "@bragi/design";
import { type CSSProperties, type ReactNode, useEffect, useId, useRef } from "react";
import { useStore } from "zustand";

import { t } from "../../../i18n/index.js";
import type { PlannerController } from "../state/planner.js";

export interface PromptBarProps {
  readonly planner: PlannerController;
  /** The canvas-pixel box of the target; `null` falls back to a fixed corner. */
  readonly anchor: {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
  } | null;
}

export function PromptBar({ planner, anchor }: PromptBarProps): ReactNode {
  const open = useStore(planner.store, (state) => state.open);
  const phase = useStore(planner.store, (state) => state.phase);
  const prompt = useStore(planner.store, (state) => state.prompt);
  const target = useStore(planner.store, (state) => state.target);
  const interpretation = useStore(planner.store, (state) => state.interpretation);
  const notices = useStore(planner.store, (state) => state.notices);
  const clarification = useStore(planner.store, (state) => state.clarification);
  const message = useStore(planner.store, (state) => state.message);
  const candidates = useStore(planner.store, (state) => state.candidates);
  const input = useRef<HTMLInputElement | null>(null);
  const headingId = useId();
  const fieldId = useId();
  const hintId = useId();

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    // A menu or the palette restores its own focus after the action; take it back afterwards.
    const timer = globalThis.setTimeout(() => input.current?.focus(), 0);
    return () => globalThis.clearTimeout(timer);
  }, [open]);

  if (!open || target === null) return null;
  const waiting = phase === "waiting";
  const canSubmit = !waiting && prompt.trim() !== "";

  const submit = (): void => {
    if (canSubmit) void planner.submit();
  };

  const position: CSSProperties =
    anchor === null
      ? { insetInlineStart: 16, insetBlockStart: 16 }
      : { insetInlineStart: Math.max(8, anchor.x), insetBlockStart: anchor.y + anchor.h + 8 };

  return (
    <section
      style={{ ...BAR, ...position }}
      role="dialog"
      aria-labelledby={headingId}
      aria-describedby={hintId}
      data-testid="prompt-bar"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        if (waiting) planner.cancel();
        else planner.close();
      }}
    >
      <header style={HEADER}>
        <h2 id={headingId} style={TITLE}>
          {t("planner.label")}
        </h2>
        <p id={hintId} style={TARGET} data-testid="planner-target">
          {target.label}
        </p>
      </header>

      <form
        style={FORM}
        aria-busy={waiting ? "true" : undefined}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <label style={LABEL} htmlFor={fieldId}>
          {t("planner.fieldLabel")}
        </label>
        <input
          ref={input}
          id={fieldId}
          style={INPUT}
          type="text"
          value={prompt}
          maxLength={2000}
          placeholder={t("planner.placeholder")}
          disabled={waiting}
          onChange={(event) => planner.setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            submit();
          }}
        />
        <fieldset style={CHIPS} aria-label={t("planner.chipsLabel")}>
          {target.chips.map((chip) => (
            <Chip
              key={chip}
              onSelect={() => {
                if (waiting) return;
                const label = t(chip);
                planner.setPrompt(label);
                void planner.submit(label);
              }}
            >
              {t(chip)}
            </Chip>
          ))}
        </fieldset>
        <div style={ACTIONS}>
          {waiting ? (
            <Button variant="secondary" size="sm" type="button" onClick={() => planner.cancel()}>
              {t("planner.cancel")}
            </Button>
          ) : (
            <Button variant="primary" size="sm" type="submit" disabled={!canSubmit}>
              {t("planner.submit")}
            </Button>
          )}
          <Button variant="ghost" size="sm" type="button" onClick={() => planner.close()}>
            {t("planner.close")}
          </Button>
        </div>
      </form>

      {waiting ? (
        <p style={STATUS} role="status" aria-live="polite" data-testid="planner-thinking">
          {t("planner.thinking")}
        </p>
      ) : null}

      {interpretation !== null ? (
        <p style={INTERPRETATION} data-testid="planner-interpretation">
          {interpretation}
        </p>
      ) : null}

      {notices.length > 0 ? (
        <ul style={NOTICES} data-testid="planner-notices">
          {notices.map((notice) => (
            <li key={notice}>{notice}</li>
          ))}
        </ul>
      ) : null}

      {clarification !== null ? (
        <div style={CLARIFICATION} data-testid="planner-clarification">
          <p style={QUESTION}>{clarification.question}</p>
          <fieldset style={CHIPS} aria-label={t("planner.clarifyLabel")}>
            {clarification.options.map((option) => (
              <Button
                key={option}
                variant="secondary"
                size="sm"
                type="button"
                onClick={() => void planner.chooseClarification(option)}
              >
                {option}
              </Button>
            ))}
          </fieldset>
        </div>
      ) : null}

      {message !== null ? (
        <p
          style={phase === "error" ? ERROR : STATUS}
          role={phase === "error" ? "alert" : "status"}
          data-testid={phase === "error" ? "planner-error" : "planner-message"}
        >
          {message}
        </p>
      ) : null}

      {candidates > 0 ? (
        <p style={STATUS} data-testid="planner-candidates">
          {t("planner.ready", { count: candidates })}
        </p>
      ) : null}
    </section>
  );
}

const BAR = {
  position: "absolute",
  zIndex: 30,
  display: "grid",
  gap: "var(--space-2)",
  width: "min(360px, calc(100vw - 32px))",
  maxHeight: "min(60vh, 520px)",
  overflow: "auto",
  padding: "var(--space-3)",
  border: "1px solid var(--color-line-strong)",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-raised)",
  boxShadow: "0 12px 32px rgb(0 0 0 / 35%)",
} as const;

const HEADER = { display: "grid", gap: 2 } as const;
const TITLE = { margin: 0, fontSize: "var(--text-base)", fontWeight: 600 } as const;
const TARGET = {
  margin: 0,
  color: "var(--color-text-muted)",
  fontSize: "var(--text-sm)",
} as const;
const FORM = { display: "grid", gap: "var(--space-2)" } as const;
const LABEL = { fontSize: "var(--text-sm)", fontWeight: 500 } as const;
const INPUT = {
  width: "100%",
  minHeight: 32,
  padding: "var(--space-1) var(--space-2)",
  border: "1px solid var(--color-line-strong)",
  borderRadius: "var(--radius-sm)",
  background: "var(--color-surface)",
  color: "var(--color-text)",
  font: "inherit",
} as const;
const CHIPS = {
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--space-1)",
  margin: 0,
  padding: 0,
  border: 0,
  minWidth: 0,
} as const;
const ACTIONS = { display: "flex", gap: "var(--space-1)" } as const;
const STATUS = {
  margin: 0,
  color: "var(--color-text-muted)",
  fontSize: "var(--text-sm)",
} as const;
const INTERPRETATION = { margin: 0, fontSize: "var(--text-sm)" } as const;
const NOTICES = {
  margin: 0,
  paddingInlineStart: "var(--space-3)",
  color: "var(--color-text-muted)",
  fontSize: "var(--text-sm)",
} as const;
const CLARIFICATION = { display: "grid", gap: "var(--space-1)" } as const;
const QUESTION = { margin: 0, fontSize: "var(--text-sm)", fontWeight: 500 } as const;
const ERROR = {
  margin: 0,
  color: "var(--color-warning)",
  fontSize: "var(--text-sm)",
} as const;
