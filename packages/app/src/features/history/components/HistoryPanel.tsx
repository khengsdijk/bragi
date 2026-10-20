/**
 * The version tree panel (07 §7): rows newest first, a lane per branch, and the actions a version
 * supports. All graph decisions live in {@link layoutTree}; this file only positions and
 * virtualises the rows.
 *
 * Only visible rows exist in the DOM. The focused row is kept in state and always rendered (it
 * may be outside the viewport after a wheel scroll), so focus never disappears while the list
 * virtualises. Arrow keys scroll the focused row into view.
 */
import { Button, Chip, Dialog, DialogClose, IconButton, Menu, MenuItem } from "@bragi/design";
import type { Region as CanvasRegion, Selection } from "@bragi/render-canvas";
import type { Project, Region } from "@bragi/schemas";
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useStore } from "zustand";

import { type MessageKey, t } from "../../../i18n/index.js";
import type { ModelApi } from "../../song/model/model-api.js";
import type { ApplyOutcome } from "../../song/state/song-store.js";
import { BranchNameError, type CommitAuthorKind } from "../api/history-repo.js";
import type { History } from "../state/history.js";
import { regionBoundariesAlign } from "../state/history.js";
import { layoutTree, type TreeRow } from "./layout-tree.js";

/** Fixed row height: the virtualiser and the connector SVG both need one number. */
export const HISTORY_ROW_HEIGHT = 32;
/** Horizontal space one lane needs for its dot and line. */
const LANE_WIDTH = 14;
/** Rows rendered above and below the viewport, so a fast wheel does not flash empty space. */
const OVERSCAN = 6;
/** Used before the first resize measurement (and in jsdom, which has no layout). */
const FALLBACK_HEIGHT = 420;

const SR_ONLY: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: "hidden",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
  border: 0,
};

const PANEL: CSSProperties = {
  display: "grid",
  gridTemplateRows: "auto minmax(0, 1fr) auto",
  minWidth: 0,
  border: "1px solid var(--color-line)",
  borderRadius: "var(--radius-lg)",
  background: "var(--color-surface)",
  color: "var(--color-text)",
};

const HEADER: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-2)",
  padding: "var(--space-2) var(--space-3)",
  borderBottom: "1px solid var(--color-line)",
};

const TITLE: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-lg)",
  fontWeight: "var(--weight-semibold)",
};

const SCROLLER: CSSProperties = {
  position: "relative",
  height: "min(60vh, 520px)",
  overflowY: "auto",
  overflowX: "hidden",
};

/**
 * The canvas selection uses a readonly track list; the model schema wants a mutable one.
 * Copying here keeps the conversion at the one boundary where the panel acts on a region.
 */
function toModelRegion(region: CanvasRegion): Region {
  return {
    startTick: region.startTick,
    endTick: region.endTick,
    tracks: region.tracks === "all" ? "all" : [...region.tracks],
  };
}

const FOOTER: CSSProperties = {
  display: "grid",
  gap: "var(--space-1)",
  padding: "var(--space-2) var(--space-3)",
  borderTop: "1px solid var(--color-line)",
};

const ROW_BASE: CSSProperties = {
  position: "absolute",
  left: 0,
  right: 0,
  display: "flex",
  alignItems: "center",
  gap: "var(--space-1)",
  minWidth: 0,
  paddingRight: "var(--space-2)",
  border: 0,
  borderInlineStart: "2px solid transparent",
  color: "inherit",
  textAlign: "start",
};

const LABEL: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: "var(--text-base)",
};

const MUTED: CSSProperties = {
  color: "var(--color-text-muted)",
  fontSize: "var(--text-xs)",
  whiteSpace: "nowrap",
};

const AUTHOR_ICON: CSSProperties = {
  flex: "none",
  width: "1.25em",
  textAlign: "center",
  fontSize: "var(--text-xs)",
};

/** The visible name of a row: commit label, or the analysis summary. */
function rowLabel(row: TreeRow): string {
  return row.kind === "analysis" ? t("history.panel.analysis") : row.commit.label;
}

/** A stable key and DOM id. An expanded analysis row keeps its own key, separate from its stages. */
function rowKey(row: TreeRow): string {
  return row.kind === "analysis" ? `analysis:${row.id}` : row.id;
}

/** Test hooks and focus both use the commit id; analysis rows get their own prefix. */
function rowTestId(row: TreeRow): string {
  return row.kind === "analysis" ? `history-analysis-${row.id}` : `history-row-${row.id}`;
}

function authorPresentation(kind: CommitAuthorKind): {
  readonly glyph: string;
  readonly label: MessageKey;
} {
  switch (kind) {
    case "ai":
      return { glyph: "✨", label: "history.panel.author.ai" };
    case "system":
      return { glyph: "⚙", label: "history.panel.author.system" };
    case "user":
      return { glyph: "👤", label: "history.panel.author.user" };
  }
}

/** The row's author; an analysis summary is always `system`-authored. */
function authorKind(row: TreeRow): CommitAuthorKind {
  return row.kind === "analysis" ? "system" : row.commit.authorKind;
}

export interface HistoryPanelProps {
  readonly history: History;
  readonly selection: Selection;
  readonly model: ModelApi;
  /** The document on screen, for the section-boundary check before adopting a region. */
  readonly liveDoc: Project | null;
  readonly onClose: () => void;
  /**
   * Called after checkout or adopt with the Song Store outcome. The workspace forwards it to the
   * engine and announces `message`; a failed or missing outcome is announced as rejected there.
   */
  readonly onCommitOutcome?: (outcome: ApplyOutcome | null, message: string) => void;
  /** Opens the two chosen versions in the Audition bar (07 §7 Compare). Absent: no Compare. */
  readonly onCompare?: (a: string, b: string) => void;
}

interface Naming {
  readonly id: string;
  readonly label: string;
}

interface PendingAdopt {
  readonly id: string;
  readonly label: string;
  readonly region: Region;
}

export function HistoryPanel({
  history,
  selection,
  model,
  liveDoc,
  onClose,
  onCommitOutcome,
  onCompare,
}: HistoryPanelProps) {
  const state = useStore(history.store);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [compare, setCompare] = useState<readonly string[]>([]);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(FALLBACK_HEIGHT);
  const [naming, setNaming] = useState<Naming | null>(null);
  const [branchName, setBranchName] = useState("");
  const [branchError, setBranchError] = useState<string | null>(null);
  const [pendingAdopt, setPendingAdopt] = useState<PendingAdopt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement | null>(null);

  const layout = useMemo(
    () =>
      layoutTree(state.commits, state.head, {
        expanded,
        branches: state.branches,
        starred: state.starred,
      }),
    [state.commits, state.head, state.branches, state.starred, expanded],
  );

  const rows = layout.rows;
  const focusedIndex = rows.findIndex((row) => rowKey(row) === focusedKey);

  // Keep the focused row valid when checkout or a collapse removes it, and start on HEAD.
  useEffect(() => {
    if (rows.length === 0) return;
    const exists = focusedIndex >= 0;
    if (exists) return;
    const head = rows.findIndex((row) => row.isHead);
    const next = rows[head >= 0 ? head : 0];
    if (next !== undefined) setFocusedKey(rowKey(next));
  }, [rows, focusedIndex]);

  // A side panel may be resized; jsdom has no ResizeObserver and keeps the fallback.
  useEffect(() => {
    const element = scroller.current;
    if (element === null) return;
    const measure = (): void => setViewportHeight(element.clientHeight || FALLBACK_HEIGHT);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Arrow keys move the focused row; keep it in the viewport without relying on DOM focus.
  useEffect(() => {
    const element = scroller.current;
    if (element === null || focusedIndex < 0) return;
    const top = focusedIndex * HISTORY_ROW_HEIGHT;
    const bottom = top + HISTORY_ROW_HEIGHT;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (bottom > element.scrollTop + element.clientHeight) {
      element.scrollTop = bottom - element.clientHeight;
    }
    setScrollTop(element.scrollTop);
  }, [focusedIndex, focusedKey]);

  // Focus is derived from `focusedKey`; the element may have just mounted through virtualisation.
  // Only a focus change may move focus, so starring a version does not steal it from that button.
  useEffect(() => {
    if (focusedKey === null) return;
    const element = scroller.current?.querySelector<HTMLElement>(
      `[data-history-key="${focusedKey}"]`,
    );
    element?.focus({ preventScroll: true });
  }, [focusedKey]);

  const first = Math.max(0, Math.floor(scrollTop / HISTORY_ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(
    rows.length - 1,
    Math.ceil((scrollTop + viewportHeight) / HISTORY_ROW_HEIGHT) + OVERSCAN,
  );
  const visible = new Set<number>();
  for (let index = first; index <= last; index += 1) visible.add(index);
  if (focusedIndex >= 0) visible.add(focusedIndex);
  const visibleRows = [...visible].sort((a, b) => a - b);

  const laneX = (lane: number): number => 8 + lane * LANE_WIDTH;

  const toggleAnalysis = useCallback((id: string, next?: boolean): void => {
    setExpanded((previous) => {
      const value = next ?? !previous.has(id);
      const copy = new Set(previous);
      if (value) copy.add(id);
      else copy.delete(id);
      return copy;
    });
  }, []);

  const toggleCompare = useCallback((id: string): void => {
    setCompare((previous) => {
      if (previous.includes(id)) return previous.filter((entry) => entry !== id);
      const next = previous.length >= 2 ? previous.slice(1) : [...previous];
      next.push(id);
      return next;
    });
  }, []);

  const checkout = useCallback(
    async (row: TreeRow): Promise<void> => {
      if (row.kind === "analysis") {
        toggleAnalysis(row.id);
        return;
      }
      if (row.commit.state !== "committed" || row.commit.id === state.head) return;
      setBusy(true);
      setError(null);
      try {
        const outcome = await history.checkout(row.commit.id);
        onCommitOutcome?.(outcome, t("history.panel.wentBack", { label: row.commit.label }));
      } catch (cause) {
        console.warn("could not go back to that version", cause);
        setError(t("history.panel.versionMissing"));
      } finally {
        setBusy(false);
      }
    },
    [history, onCommitOutcome, state.head, toggleAnalysis],
  );

  const adopt = useCallback(
    async (id: string, label: string, region: Region): Promise<void> => {
      setBusy(true);
      try {
        const outcome = await history.adoptRegion(region, id);
        onCommitOutcome?.(outcome, t("history.panel.tookPart", { label }));
      } catch (cause) {
        console.warn("could not take that part", cause);
        setError(t("history.panel.versionMissing"));
      } finally {
        setBusy(false);
      }
    },
    [history, onCommitOutcome],
  );

  const startAdopt = useCallback(
    async (row: TreeRow, region: Region): Promise<void> => {
      if (liveDoc === null) return;
      const id = row.kind === "analysis" ? row.id : row.commit.id;
      const label = rowLabel(row);
      setBusy(true);
      setError(null);
      try {
        const source = await history.readSnapshot(id);
        if (source === null) {
          setError(t("history.panel.versionMissing"));
          return;
        }
        if (!regionBoundariesAlign(model, liveDoc, source, region)) {
          setPendingAdopt({ id, label, region });
          return;
        }
        await adopt(id, label, region);
      } catch (cause) {
        console.warn("could not read that version", cause);
        setError(t("history.panel.versionMissing"));
      } finally {
        setBusy(false);
      }
    },
    [adopt, history, liveDoc, model],
  );

  const saveBranchName = useCallback(async (): Promise<void> => {
    if (naming === null) return;
    setBranchError(null);
    try {
      await history.nameBranch(branchName, naming.id);
      setNaming(null);
      setBranchName("");
    } catch (cause) {
      setBranchError(
        cause instanceof BranchNameError ? cause.message : t("history.panel.nameFailed"),
      );
    }
  }, [branchName, history, naming]);

  const moveFocus = useCallback(
    (delta: number | "first" | "last"): void => {
      if (rows.length === 0) return;
      let index = focusedIndex;
      if (delta === "first") index = 0;
      else if (delta === "last") index = rows.length - 1;
      else
        index = Math.max(
          0,
          Math.min(rows.length - 1, (focusedIndex < 0 ? 0 : focusedIndex) + delta),
        );
      const row = rows[index];
      if (row !== undefined) setFocusedKey(rowKey(row));
    },
    [focusedIndex, rows],
  );

  const onRowKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>, row: TreeRow): void => {
      // A star or menu button handles its own keys.
      if (event.target !== event.currentTarget) return;
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          moveFocus(1);
          break;
        case "ArrowUp":
          event.preventDefault();
          moveFocus(-1);
          break;
        case "Home":
          event.preventDefault();
          moveFocus("first");
          break;
        case "End":
          event.preventDefault();
          moveFocus("last");
          break;
        case "ArrowRight":
          if (row.kind === "analysis") {
            event.preventDefault();
            toggleAnalysis(row.id, true);
          }
          break;
        case "ArrowLeft":
          if (row.kind === "analysis") {
            event.preventDefault();
            toggleAnalysis(row.id, false);
          }
          break;
        case "Enter":
          event.preventDefault();
          setFocusedKey(rowKey(row));
          void checkout(row);
          break;
        case " ":
          event.preventDefault();
          setFocusedKey(rowKey(row));
          toggleCompare(row.id);
          break;
        case "Escape":
          event.preventDefault();
          event.stopPropagation();
          onClose();
          break;
        default:
          break;
      }
    },
    [checkout, moveFocus, onClose, toggleAnalysis, toggleCompare],
  );

  const onRowClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>, row: TreeRow): void => {
      if (event.target instanceof HTMLElement && event.target.closest("button") !== null) return;
      setFocusedKey(rowKey(row));
      if (event.shiftKey || event.metaKey || event.ctrlKey) {
        toggleCompare(row.id);
        return;
      }
      void checkout(row);
    },
    [checkout, toggleCompare],
  );

  const region = selection.kind === "region" ? toModelRegion(selection.region) : null;
  const totalHeight = rows.length * HISTORY_ROW_HEIGHT;
  const connectors: string[] = [];
  for (const [index, row] of rows.entries()) {
    if (row.parent === null) continue;
    const low = Math.min(index, row.parent.row);
    const high = Math.max(index, row.parent.row);
    if (high < first - 1 || low > last + 1) continue;
    const x1 = laneX(row.lane);
    const y1 = index * HISTORY_ROW_HEIGHT + HISTORY_ROW_HEIGHT / 2;
    const x2 = laneX(row.parent.lane);
    const y2 = row.parent.row * HISTORY_ROW_HEIGHT + HISTORY_ROW_HEIGHT / 2;
    connectors.push(`M ${x1} ${y1} L ${x1} ${y2} L ${x2} ${y2}`);
  }

  return (
    <aside
      style={PANEL}
      aria-label={t("history.panel.label")}
      data-testid="history-panel"
      aria-busy={busy ? "true" : undefined}
    >
      <header style={HEADER}>
        <h2 style={TITLE}>{t("history.panel.label")}</h2>
        <IconButton label={t("history.panel.close")} size="sm" onClick={onClose}>
          <span aria-hidden="true">×</span>
        </IconButton>
      </header>
      <div
        ref={scroller}
        style={SCROLLER}
        data-testid="history-scroller"
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        {rows.length === 0 ? (
          <p style={{ padding: "var(--space-3)", color: "var(--color-text-muted)" }}>
            {t("history.panel.empty")}
          </p>
        ) : (
          <div style={{ position: "relative", height: totalHeight }}>
            <svg
              aria-hidden="true"
              width={8 + layout.laneCount * LANE_WIDTH}
              height={totalHeight}
              style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
            >
              {connectors.map((path, index) => (
                <path
                  // Paths have no identity beyond their position in this render.
                  key={index}
                  d={path}
                  fill="none"
                  stroke="var(--color-line-strong)"
                  strokeWidth={1.5}
                />
              ))}
            </svg>
            <div
              role="tree"
              aria-label={t("history.panel.label")}
              aria-multiselectable="true"
              // The tree spans the spacer, so it has a box of its own (rows are positioned in it).
              style={{ position: "absolute", inset: 0 }}
            >
              {visibleRows.map((index) => {
                const row = rows[index];
                if (row === undefined) return null;
                const key = rowKey(row);
                const selected = row.isHead || compare.includes(row.id);
                const description = authorPresentation(authorKind(row));
                const faded = row.kind === "commit" && row.commit.state !== "committed";
                const chips = row.branchNames.map((name) => (
                  <Chip key={name} tone="accent">
                    {name}
                  </Chip>
                ));
                return (
                  <div
                    key={key}
                    role="treeitem"
                    aria-level={row.depth === 0 ? 1 : 2}
                    aria-selected={selected}
                    {...(row.isHead ? { "aria-current": "true" as const } : {})}
                    {...(row.kind === "analysis" ? { "aria-expanded": row.expanded } : {})}
                    tabIndex={key === focusedKey ? 0 : -1}
                    data-history-key={key}
                    data-testid={rowTestId(row)}
                    data-state={row.kind === "commit" ? row.commit.state : "committed"}
                    onClick={(event) => onRowClick(event, row)}
                    onKeyDown={(event) => onRowKeyDown(event, row)}
                    style={{
                      ...ROW_BASE,
                      top: index * HISTORY_ROW_HEIGHT,
                      height: HISTORY_ROW_HEIGHT,
                      paddingLeft: row.depth === 1 ? laneX(row.lane) + 28 : laneX(row.lane) + 12,
                      // Faded by colour, not opacity: muted text at reduced opacity fails
                      // contrast (11 §3), and the label must stay readable.
                      color: faded ? "var(--color-text-muted)" : undefined,
                      background: row.isHead ? "var(--color-accent-quiet)" : undefined,
                      borderInlineStartColor: row.isHead ? "var(--color-accent)" : "transparent",
                      cursor:
                        row.kind === "analysis" ||
                        (row.kind === "commit" && row.commit.state === "committed")
                          ? "pointer"
                          : "default",
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        position: "absolute",
                        left: laneX(row.lane) - 3,
                        top: HISTORY_ROW_HEIGHT / 2 - 3,
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: row.isHead ? "var(--color-accent)" : "var(--color-line-strong)",
                      }}
                    />
                    <span aria-hidden="true" style={AUTHOR_ICON}>
                      {description.glyph}
                    </span>
                    <span style={SR_ONLY}>{t(description.label)}</span>
                    <span style={LABEL}>{rowLabel(row)}</span>
                    {row.kind === "analysis" ? (
                      <span style={MUTED}>
                        {t("history.panel.analysisCount", { count: row.commits.length })}
                      </span>
                    ) : null}
                    {row.isHead ? <Chip tone="accent">{t("history.panel.current")}</Chip> : null}
                    {chips}
                    {row.kind === "commit" && row.commit.state === "discarded" ? (
                      <span style={MUTED}>
                        <span aria-hidden="true">· </span>
                        {t("history.panel.discarded")}
                      </span>
                    ) : null}
                    {row.kind === "commit" && row.commit.state === "candidate" ? (
                      <span style={MUTED}>
                        <span aria-hidden="true">✨ </span>
                        {t("history.panel.candidate")}
                      </span>
                    ) : null}
                    <span style={{ flex: 1 }} />
                    <Menu
                      label={t("history.panel.menu")}
                      modal={false}
                      trigger={
                        // Must be `Button`: Radix's trigger props only reach a component that
                        // forwards them, and `IconButton` consumes its own props instead.
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={t("history.panel.actions", { label: rowLabel(row) })}
                        >
                          <span aria-hidden="true">⋯</span>
                        </Button>
                      }
                    >
                      <MenuItem
                        onSelect={() => {
                          setNaming({ id: row.id, label: rowLabel(row) });
                          setBranchName("");
                          setBranchError(null);
                        }}
                      >
                        {t("history.panel.name")}
                      </MenuItem>
                      <MenuItem
                        onSelect={() => {
                          if (row.starred) void history.unstar(row.id);
                          else void history.star(row.id);
                        }}
                      >
                        {t(row.starred ? "history.panel.unstar" : "history.panel.star", {
                          label: rowLabel(row),
                        })}
                      </MenuItem>
                      <MenuItem
                        disabled={region === null}
                        onSelect={() => {
                          if (region !== null) void startAdopt(row, region);
                        }}
                      >
                        {t("history.panel.takePart")}
                      </MenuItem>
                    </Menu>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t(row.starred ? "history.panel.unstar" : "history.panel.star", {
                        label: rowLabel(row),
                      })}
                      aria-pressed={row.starred}
                      onClick={() => {
                        if (row.starred) void history.unstar(row.id);
                        else void history.star(row.id);
                      }}
                    >
                      <span aria-hidden="true">{row.starred ? "★" : "☆"}</span>
                    </Button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
      <footer style={FOOTER}>
        <Button
          disabled={onCompare === undefined || compare.length !== 2}
          aria-describedby="history-compare-hint"
          data-testid="history-compare"
          onClick={() => {
            const [a, b] = compare;
            if (a !== undefined && b !== undefined) onCompare?.(a, b);
          }}
        >
          {t("history.panel.compare")}
        </Button>
        <span id="history-compare-hint" style={MUTED}>
          {compare.length > 0
            ? t("history.panel.compareSelected", { count: compare.length })
            : t("history.panel.compareHint")}
        </span>
        {error === null ? null : (
          <p role="alert" style={{ margin: 0, color: "var(--color-danger)" }}>
            {error}
          </p>
        )}
      </footer>

      <Dialog
        open={naming !== null}
        onOpenChange={(open) => {
          if (!open) {
            setNaming(null);
            setBranchError(null);
          }
        }}
        title={t("history.panel.name")}
        closeLabel={t("history.panel.close")}
        size="sm"
        footer={
          <>
            <DialogClose asChild>
              <Button>{t("history.panel.nameCancel")}</Button>
            </DialogClose>
            <Button variant="primary" onClick={() => void saveBranchName()}>
              {t("history.panel.nameSave")}
            </Button>
          </>
        }
      >
        <label
          htmlFor="history-branch-name"
          style={{ display: "grid", gap: "var(--space-1)", fontSize: "var(--text-xs)" }}
        >
          {t("history.panel.nameLabel")}
          <input
            id="history-branch-name"
            value={branchName}
            onChange={(event) => setBranchName(event.target.value)}
            aria-invalid={branchError !== null}
            {...(branchError === null ? {} : { "aria-describedby": "history-branch-error" })}
            style={{
              minHeight: "var(--size-control-md)",
              paddingInline: "var(--space-2)",
              border: "1px solid var(--color-line-strong)",
              borderRadius: "var(--radius-sm)",
              background: "var(--color-surface-raised)",
              color: "var(--color-text)",
              font: "inherit",
            }}
          />
        </label>
        {branchError === null ? null : (
          <p
            id="history-branch-error"
            role="alert"
            style={{ margin: 0, color: "var(--color-danger)" }}
          >
            {branchError}
          </p>
        )}
      </Dialog>

      <Dialog
        open={pendingAdopt !== null}
        onOpenChange={(open) => {
          if (!open) setPendingAdopt(null);
        }}
        title={t("history.panel.boundariesTitle")}
        description={t("history.panel.boundariesWarning")}
        closeLabel={t("history.panel.close")}
        size="sm"
        footer={
          <>
            <DialogClose asChild>
              <Button>{t("history.panel.nameCancel")}</Button>
            </DialogClose>
            <Button
              variant="primary"
              onClick={() => {
                const pending = pendingAdopt;
                if (pending === null) return;
                setPendingAdopt(null);
                void adopt(pending.id, pending.label, pending.region);
              }}
            >
              {t("history.panel.boundariesConfirm")}
            </Button>
          </>
        }
      />
    </aside>
  );
}
