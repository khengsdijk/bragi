import { Toast as RadixToast } from "radix-ui";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";

import { cx } from "../css.js";
import { Icon } from "../Icon/Icon.js";
import styles from "./Toast.module.css";

export type ToastTone = "neutral" | "success" | "warning" | "danger";

export interface ToastOptions {
  /** Headline. Plain language, ≤ 12 words (11 §2). */
  readonly title: string;
  /** Optional second line, for the detail that does not fit the headline. */
  readonly description?: string;
  readonly tone?: ToastTone;
  /** One optional action, e.g. "Undo" or "Details". */
  readonly action?: { readonly label: string; readonly onSelect: () => void };
  /** Milliseconds before it dismisses itself. `0` keeps it until dismissed. */
  readonly duration?: number;
  /** Stable id, so repeating an action replaces its own toast instead of stacking. */
  readonly id?: string;
}

interface ToastEntry extends ToastOptions {
  readonly id: string;
}

export interface ToastController {
  /** Show a toast. Returns its id. */
  readonly toast: (options: ToastOptions) => string;
  /** Dismiss one toast, or every toast when called without an id. */
  readonly dismiss: (id?: string) => void;
}

const ToastContext = createContext<ToastController | null>(null);

export interface ToastProviderProps {
  readonly children: ReactNode;
  /** Accessible name for the toast region, e.g. "Notifications". */
  readonly label: string;
  /** Accessible name for each toast's close button, e.g. "Dismiss". */
  readonly closeLabel: string;
}

/**
 * Radix Toast plus a small controller. Toasts announce themselves (`role="status"`, polite or
 * assertive by tone) and are reachable with the region's hotkey (F8 by default), so a message
 * is never only a visual event (11 §6.3).
 */
export function ToastProvider({ children, label, closeLabel }: ToastProviderProps) {
  const [toasts, setToasts] = useState<readonly ToastEntry[]>([]);
  const counter = useRef(0);

  const dismiss = useCallback((id?: string) => {
    setToasts((previous) => (id === undefined ? [] : previous.filter((entry) => entry.id !== id)));
  }, []);

  const toast = useCallback((options: ToastOptions) => {
    counter.current += 1;
    const id = options.id ?? `toast-${counter.current}`;
    setToasts((previous) => [...previous.filter((entry) => entry.id !== id), { ...options, id }]);
    return id;
  }, []);

  const controller = useMemo<ToastController>(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={controller}>
      <RadixToast.Provider swipeDirection="right">
        {children}
        {toasts.map((entry) => (
          <RadixToast.Root
            key={entry.id}
            className={styles.toast}
            data-tone={entry.tone ?? "neutral"}
            defaultOpen
            {...(entry.duration === undefined ? {} : { duration: entry.duration })}
            type={entry.tone === "danger" ? "foreground" : "background"}
            onOpenChange={(open) => {
              if (!open) dismiss(entry.id);
            }}
          >
            <RadixToast.Title className={styles.title}>{entry.title}</RadixToast.Title>
            <RadixToast.Close className={styles.close} aria-label={closeLabel}>
              <Icon>
                <path d="M4 4l8 8M12 4l-8 8" />
              </Icon>
            </RadixToast.Close>
            {entry.description === undefined ? null : (
              <RadixToast.Description className={styles.description}>
                {entry.description}
              </RadixToast.Description>
            )}
            {entry.action === undefined ? null : (
              <RadixToast.Action
                className={styles.action}
                altText={entry.action.label}
                onClick={entry.action.onSelect}
              >
                {entry.action.label}
              </RadixToast.Action>
            )}
          </RadixToast.Root>
        ))}
        <RadixToast.Viewport className={cx(styles.viewport)} label={label} />
      </RadixToast.Provider>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastController {
  const controller = useContext(ToastContext);
  if (controller === null) {
    throw new Error("useToast must be used inside <ToastProvider>");
  }
  return controller;
}
