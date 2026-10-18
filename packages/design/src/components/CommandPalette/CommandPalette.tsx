import { Dialog as RadixDialog } from "radix-ui";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { cx } from "../css.js";
import styles from "./CommandPalette.module.css";

export interface CommandPaletteItem {
  readonly id: string;
  readonly label: string;
  /** Optional heading the item is listed under. */
  readonly group?: string;
  /** Right-aligned hint, usually a shortcut. */
  readonly hint?: string;
  /** Extra terms the search matches on, so "spread" finds "More spacious". */
  readonly keywords?: readonly string[];
  readonly disabled?: boolean;
}

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly items: readonly CommandPaletteItem[];
  /** Called when an item is chosen; the palette closes before this runs. */
  readonly onSelect: (item: CommandPaletteItem) => void;
  /** The palette's heading, also its accessible name. */
  readonly label: string;
  readonly placeholder: string;
  /** Shown when nothing matches, e.g. "No matching commands". */
  readonly emptyLabel: string;
  /** Replace the default "every word must appear in the label or keywords" match. */
  readonly filter?: (item: CommandPaletteItem, query: string) => boolean;
  readonly footer?: ReactNode;
  readonly className?: string;
}

/**
 * The command palette (`Cmd/Ctrl+K`, [11 §6.2](../../../../specs/11-ux-and-accessibility.md)).
 *
 * It is a Radix Dialog — so focus is trapped, Esc closes it and focus returns to where it was —
 * holding an ARIA combobox and listbox we own, rather than pulling in a command-menu library for
 * ~150 lines of keyboard handling.
 */
export function CommandPalette({
  open,
  onOpenChange,
  items,
  onSelect,
  label,
  placeholder,
  emptyLabel,
  filter,
  footer,
  className,
}: CommandPaletteProps) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [requestedId, setRequestedId] = useState<string | null>(null);

  const matched = useMemo(
    () => items.filter((item) => (filter ?? defaultFilter)(item, query.trim().toLowerCase())),
    [items, query, filter],
  );

  const selectable = useMemo(
    () => matched.filter((item) => item.disabled !== true).map((item) => item.id),
    [matched],
  );

  const hasMatches = matched.length > 0;

  // Derived rather than stored: the highlighted item is whichever was requested if it is still
  // on screen, otherwise the first selectable one. No effect, so no render loops.
  const activeId =
    requestedId !== null && selectable.includes(requestedId)
      ? requestedId
      : (selectable[0] ?? null);

  useEffect(() => {
    if (open) return;
    setQuery("");
    setRequestedId(null);
  }, [open]);

  useEffect(() => {
    if (activeId === null) return;
    const element = document.getElementById(optionId(listId, activeId));
    element?.scrollIntoView({ block: "nearest" });
  }, [activeId, listId]);

  const move = (delta: number): void => {
    if (selectable.length === 0) return;
    const index = activeId === null ? -1 : selectable.indexOf(activeId);
    const next = index === -1 ? (delta > 0 ? 0 : selectable.length - 1) : index + delta;
    const wrapped = ((next % selectable.length) + selectable.length) % selectable.length;
    const id = selectable[wrapped];
    if (id !== undefined) setRequestedId(id);
  };

  const choose = (id: string | null): void => {
    if (id === null) return;
    const item = matched.find((entry) => entry.id === id);
    if (item === undefined || item.disabled === true) return;
    onOpenChange(false);
    onSelect(item);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        move(-1);
        break;
      case "Home":
        event.preventDefault();
        setRequestedId(selectable[0] ?? null);
        break;
      case "End":
        event.preventDefault();
        setRequestedId(selectable[selectable.length - 1] ?? null);
        break;
      case "Enter":
        event.preventDefault();
        choose(activeId);
        break;
      default:
        break;
    }
  };

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={styles.overlay} />
        <RadixDialog.Content
          className={cx(styles.content, className)}
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            inputRef.current?.focus();
          }}
        >
          <RadixDialog.Title className={styles.srOnly}>{label}</RadixDialog.Title>
          <input
            ref={inputRef}
            className={styles.input}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-label={label}
            aria-controls={listId}
            {...(activeId === null || !hasMatches
              ? {}
              : { "aria-activedescendant": optionId(listId, activeId) })}
            autoComplete="off"
            spellCheck={false}
            placeholder={placeholder}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          <div
            className={styles.list}
            id={listId}
            role="listbox"
            aria-label={label}
            hidden={!hasMatches}
          >
            {hasMatches
              ? groupsOf(matched).map(([group, entries]) => (
                  <fieldset key={group ?? ""} className={styles.group}>
                    {group === null ? null : <legend className={styles.groupLabel}>{group}</legend>}
                    {entries.map((item) => (
                      <div
                        key={item.id}
                        id={optionId(listId, item.id)}
                        role="option"
                        aria-selected={item.id === activeId}
                        {...(item.disabled === true ? { "aria-disabled": "true" } : {})}
                        className={cx(styles.option)}
                        data-active={item.id === activeId ? "true" : undefined}
                        data-disabled={item.disabled === true ? "true" : undefined}
                        // Focus stays in the combobox (11 §6.2): options are pointed at by
                        // aria-activedescendant and clicked, never tabbed to.
                        tabIndex={-1}
                        onPointerDown={(event) => {
                          event.preventDefault();
                          choose(item.id);
                        }}
                      >
                        <span className={styles.optionLabel}>{item.label}</span>
                        {item.hint === undefined ? null : (
                          <span className={styles.hint}>{item.hint}</span>
                        )}
                      </div>
                    ))}
                  </fieldset>
                ))
              : null}
          </div>
          {hasMatches ? null : <p className={styles.empty}>{emptyLabel}</p>}
          {footer === undefined ? null : <div className={styles.footer}>{footer}</div>}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

function optionId(listId: string, itemId: string): string {
  return `${listId}-${itemId}`;
}

function groupsOf(
  items: readonly CommandPaletteItem[],
): readonly (readonly [string | null, readonly CommandPaletteItem[]])[] {
  const order: (string | null)[] = [];
  const byGroup = new Map<string | null, CommandPaletteItem[]>();
  for (const item of items) {
    const key = item.group ?? null;
    const bucket = byGroup.get(key);
    if (bucket === undefined) {
      byGroup.set(key, [item]);
      order.push(key);
    } else {
      bucket.push(item);
    }
  }
  return order.map((key) => [key, byGroup.get(key) ?? []] as const);
}

function defaultFilter(item: CommandPaletteItem, query: string): boolean {
  if (query === "") return true;
  const haystack = [item.label, ...(item.keywords ?? [])].join(" ").toLowerCase();
  return query.split(/\s+/).every((token) => haystack.includes(token));
}
