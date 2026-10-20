/**
 * The Audition bar (07 §6): the prompt, one chip per slot with its status badge, and the group's
 * actions. `0–3` switch slots (`A`/`B` in a comparison), the arrow keys move between the bar's
 * controls (a toolbar, 11 §6.2), Escape closes a comparison.
 */
import { Button, Chip } from "@bragi/design";
import type { AuditionSlot } from "@bragi/platform";
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useRef } from "react";
import { useStore } from "zustand";

import { t } from "../../../i18n/index.js";
import type { Audition, AuditionCandidate } from "../state/audition.js";
import { type CandidateStatus, isPlayable } from "../state/candidate-status.js";

export interface AuditionBarProps {
  readonly audition: Audition;
}

/** Whether a key press belongs to a text field, a dialog or a menu rather than the bar. */
function ownedElsewhere(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.closest("input, textarea, select")) return true;
  return target.closest('[role="dialog"], [role="menu"], [role="listbox"]') !== null;
}

function statusText(status: CandidateStatus): string {
  switch (status.kind) {
    case "queued":
      return t("audition.status.queued");
    case "generating":
      return t("audition.status.generating", { pct: Math.round(status.pct * 100) });
    case "preview":
      return t("audition.status.preview");
    case "hq":
      return t("audition.status.hq");
    case "failed":
      return t("audition.status.failed");
  }
}

/** The key that selects a slot: digits for candidates, A/B in a comparison. */
function slotKey(kind: "candidates" | "compare", slot: AuditionSlot): string {
  if (kind === "candidates") return String(slot);
  return slot === 1 ? "A" : slot === 2 ? "B" : "0";
}

export function AuditionBar({ audition }: AuditionBarProps): ReactNode {
  const group = useStore(audition.store, (state) => state.group);
  const selected = useStore(audition.store, (state) => state.selected);
  const warm = useStore(audition.store, (state) => state.warm);
  const busy = useStore(audition.store, (state) => state.busy);
  const toolbar = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (group === null) return;
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.altKey || event.metaKey || event.ctrlKey || ownedElsewhere(event.target)) return;
      const key = event.key.toUpperCase();
      let slot: AuditionSlot | null = null;
      if (group.kind === "candidates" && /^[0-3]$/.test(key)) slot = Number(key) as AuditionSlot;
      if (group.kind === "compare" && key === "A") slot = 1;
      if (group.kind === "compare" && key === "B") slot = 2;
      if (group.kind === "compare" && key === "0") slot = 0;
      if (slot !== null) {
        event.preventDefault();
        audition.select(slot);
        return;
      }
      if (event.key === "Escape" && group.kind === "compare") {
        event.preventDefault();
        void audition.discard();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [audition, group]);

  /** Roving focus across the toolbar's buttons (WAI-ARIA toolbar pattern). */
  const onToolbarKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>): void => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const buttons = [
      ...(toolbar.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? []),
    ];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (buttons.length === 0) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }, []);

  if (group === null) return null;
  const compare = group.kind === "compare";

  const chip = (slot: AuditionSlot, label: string, candidate?: AuditionCandidate): ReactNode => {
    const ready = slot === 0 || warm.includes(slot as 1 | 2 | 3);
    const pressed = selected === slot;
    return (
      <Button
        key={slot}
        variant={pressed ? "secondary" : "ghost"}
        size="sm"
        aria-pressed={pressed}
        aria-keyshortcuts={slotKey(group.kind, slot)}
        disabled={!ready}
        data-testid={`audition-slot-${slot}`}
        onClick={() => audition.select(slot)}
      >
        <span aria-hidden="true" style={KEY_HINT}>
          {slotKey(group.kind, slot)}
        </span>
        <span>{label}</span>
        {candidate !== undefined && !compare ? (
          <Chip tone={isPlayable(candidate.status) ? "accent" : "neutral"}>
            {statusText(candidate.status)}
          </Chip>
        ) : null}
      </Button>
    );
  };

  return (
    <div
      ref={toolbar}
      role="toolbar"
      aria-label={t(compare ? "audition.compareLabel" : "audition.label")}
      data-testid="audition-bar"
      aria-busy={busy ? "true" : undefined}
      onKeyDown={onToolbarKeyDown}
      style={BAR}
    >
      <p style={PROMPT} data-testid="audition-prompt">
        {group.prompt}
      </p>
      <div style={ROW}>
        {chip(0, t("audition.original"))}
        {group.candidates.map((candidate) => chip(candidate.slot, candidate.label, candidate))}
      </div>
      <div style={{ ...ROW, marginInlineStart: "auto" }}>
        {compare ? (
          <Button variant="secondary" size="sm" onClick={() => void audition.discard()}>
            {t("audition.close")}
          </Button>
        ) : (
          <>
            {audition.canMoreLike() ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={selected === 0 || busy}
                onClick={() => audition.moreLike()}
              >
                {t("audition.moreLike")}
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void audition.discard()}
            >
              {t("audition.discard")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={selected === 0 || busy}
              onClick={() => void audition.accept()}
            >
              {t("audition.accept")}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

const BAR = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "var(--space-2)",
  padding: "var(--space-2) var(--space-3)",
  border: "1px solid var(--color-line-strong)",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-raised)",
} as const;

const ROW = { display: "flex", flexWrap: "wrap", gap: "var(--space-1)" } as const;

const PROMPT = { margin: 0, fontWeight: 600, flexBasis: "100%" } as const;

const KEY_HINT = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--color-text-muted)",
  marginInlineEnd: "var(--space-1)",
} as const;
