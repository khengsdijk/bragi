/**
 * The accessible DOM grid behind the Song Canvas (11 §6.1).
 *
 * PixiJS draws into a `<canvas>`, which assistive tech cannot read, so the same data is also
 * exposed as an ARIA `grid`: rows are "Song layout", "Chords" (when known) and one row per
 * instrument, columns are parts. It is visually hidden, not removed: it is the keyboard path to
 * every canvas action, and focus in it drives the focus ring drawn on the canvas.
 *
 * Keyboard (11 §6.2): arrows move between cells, Home/End jump along a row, `Enter` selects the
 * part or instrument, `M` and `O` mute and solo the focused instrument (07 §3), `Escape` clears
 * the selection. One tab stop for the grid (roving tabindex); the mute and solo buttons of the
 * focused row are the next tab stops, so they are reachable without the shortcuts too.
 */
import type { Selection } from "@bragi/render-canvas";
import { type KeyboardEvent, type ReactNode, useCallback, useRef, useState } from "react";

import { t } from "../../../i18n/index.js";
import type { GridModel, GridRow } from "../api/grid-model.js";

export interface GridFocus {
  readonly kind: "section" | "track";
  readonly id: string;
}

export interface AccessibleGridProps {
  readonly model: GridModel;
  readonly selection: Selection;
  readonly onSelect: (selection: Selection) => void;
  readonly onToggle: (trackId: string, field: "mute" | "solo") => void;
  /** Shift+F10, the context-menu key or a right-click on a cell: open the section menu here. */
  readonly onContextMenu: (sectionId: string, element: HTMLElement) => void;
  /** The cell that has keyboard focus, or `null` when focus left the grid. */
  readonly onFocusChange: (focus: GridFocus | null) => void;
}

interface Position {
  readonly row: number;
  readonly col: number;
}

function isSelectedColumn(selection: Selection, sectionId: string): boolean {
  return selection.kind === "sections" && selection.ids.includes(sectionId);
}

function isSelectedRow(selection: Selection, row: GridRow): boolean {
  return row.kind === "instrument" && selection.kind === "tracks" && selection.ids.includes(row.id);
}

export function AccessibleGrid({
  model,
  selection,
  onSelect,
  onToggle,
  onContextMenu,
  onFocusChange,
}: AccessibleGridProps): ReactNode {
  const [active, setActive] = useState<Position>({ row: 0, col: 0 });
  const cells = useRef(new Map<string, HTMLElement>());

  const rowCount = model.rows.length;
  const colCount = model.columns.length;
  const clamped: Position = {
    row: Math.min(active.row, Math.max(0, rowCount - 1)),
    col: Math.min(active.col, Math.max(0, colCount - 1)),
  };

  const focusCell = useCallback((position: Position) => {
    setActive(position);
    cells.current.get(`${position.row}:${position.col}`)?.focus();
  }, []);

  const report = useCallback(
    (position: Position) => {
      const row = model.rows[position.row];
      const column = model.columns[position.col];
      if (!row || !column) {
        onFocusChange(null);
        return;
      }
      onFocusChange(
        row.kind === "instrument"
          ? { kind: "track", id: row.id }
          : { kind: "section", id: column.sectionId },
      );
    },
    [model, onFocusChange],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLElement>, position: Position): void => {
    // Modified keys belong to the workspace (Alt+arrows move or resize a part, Cmd/Ctrl+K opens
    // the palette). The grid only owns the unmodified navigation keys.
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    const row = model.rows[position.row];
    const column = model.columns[position.col];
    if (!row || !column) return;
    let next: Position | null = null;
    switch (event.key) {
      case "ArrowRight":
        next = { row: position.row, col: Math.min(colCount - 1, position.col + 1) };
        break;
      case "ArrowLeft":
        next = { row: position.row, col: Math.max(0, position.col - 1) };
        break;
      case "ArrowDown":
        next = { row: Math.min(rowCount - 1, position.row + 1), col: position.col };
        break;
      case "ArrowUp":
        next = { row: Math.max(0, position.row - 1), col: position.col };
        break;
      case "Home":
        next = { row: position.row, col: 0 };
        break;
      case "End":
        next = { row: position.row, col: colCount - 1 };
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        if (row.kind === "instrument") {
          onSelect({ kind: "tracks", ids: [row.id] });
        } else {
          onSelect({ kind: "sections", ids: [column.sectionId] });
        }
        return;
      case "ContextMenu":
        event.preventDefault();
        onContextMenu(column.sectionId, event.currentTarget);
        return;
      case "F10":
        if (event.shiftKey) {
          event.preventDefault();
          onContextMenu(column.sectionId, event.currentTarget);
        }
        return;
      case "Escape":
        onSelect({ kind: "none" });
        return;
      case "m":
      case "M":
        if (row.kind === "instrument" && !event.metaKey && !event.ctrlKey) {
          event.preventDefault();
          onToggle(row.id, "mute");
        }
        return;
      case "o":
      case "O":
        if (row.kind === "instrument" && !event.metaKey && !event.ctrlKey) {
          event.preventDefault();
          onToggle(row.id, "solo");
        }
        return;
      default:
        return;
    }
    event.preventDefault();
    focusCell(next);
    report(next);
  };

  return (
    <table
      // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: an interactive ARIA grid on native table markup is the 11 §6.1 model.
      role="grid"
      aria-label={t("song.grid.label")}
      aria-rowcount={rowCount + 1}
      aria-colcount={colCount + 1}
      className="song-grid"
      data-testid="song-grid"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onFocusChange(null);
      }}
    >
      <thead>
        <tr aria-rowindex={1}>
          <th scope="col" aria-colindex={1}>
            {t("song.grid.instrumentHeader")}
          </th>
          {model.columns.map((column, index) => (
            <th
              scope="col"
              aria-colindex={index + 2}
              key={column.sectionId}
              data-section-id={column.sectionId}
            >
              {column.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {model.rows.map((row, rowIndex) => {
          const rowActive = clamped.row === rowIndex;
          return (
            <tr
              aria-rowindex={rowIndex + 2}
              aria-selected={isSelectedRow(selection, row) ? true : undefined}
              key={row.id}
              data-row-kind={row.kind}
              data-row-id={row.id}
            >
              <th scope="row" aria-colindex={1}>
                {row.name}
                {row.mute ? `, ${t("song.grid.muted")}` : ""}
                {row.solo ? `, ${t("song.grid.soloed")}` : ""}
                {row.kind === "instrument" ? (
                  <>
                    <button
                      type="button"
                      aria-pressed={row.mute}
                      tabIndex={rowActive ? 0 : -1}
                      data-testid={`grid-mute-${row.id}`}
                      onClick={() => onToggle(row.id, "mute")}
                    >
                      {t(row.mute ? "song.track.unmute" : "song.track.mute", { name: row.name })}
                    </button>
                    <button
                      type="button"
                      aria-pressed={row.solo}
                      tabIndex={rowActive ? 0 : -1}
                      data-testid={`grid-solo-${row.id}`}
                      onClick={() => onToggle(row.id, "solo")}
                    >
                      {t(row.solo ? "song.track.unsolo" : "song.track.solo", { name: row.name })}
                    </button>
                  </>
                ) : null}
              </th>
              {row.cells.map((cell, colIndex) => {
                const isActive = rowActive && clamped.col === colIndex;
                const position = { row: rowIndex, col: colIndex };
                return (
                  <td
                    // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: a focusable gridcell inside the ARIA grid above.
                    role="gridcell"
                    aria-colindex={colIndex + 2}
                    aria-selected={
                      row.kind === "instrument"
                        ? isSelectedRow(selection, row) || undefined
                        : isSelectedColumn(selection, cell.sectionId) || undefined
                    }
                    key={cell.sectionId}
                    tabIndex={isActive ? 0 : -1}
                    data-section-id={cell.sectionId}
                    data-playing={cell.playing === undefined ? undefined : String(cell.playing)}
                    ref={(element) => {
                      const key = `${rowIndex}:${colIndex}`;
                      if (element) cells.current.set(key, element);
                      else cells.current.delete(key);
                    }}
                    onFocus={() => {
                      setActive(position);
                      report(position);
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      onContextMenu(cell.sectionId, event.currentTarget);
                    }}
                    onKeyDown={(event) => onKeyDown(event, position)}
                  >
                    {cell.text}
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
