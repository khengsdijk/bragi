import { Tooltip as RadixTooltip } from "radix-ui";
import { createContext, type ReactElement, type ReactNode, useContext } from "react";

import { cx } from "../css.js";
import styles from "./Tooltip.module.css";

/**
 * Radix needs a `Tooltip.Provider` above every tooltip. Ours records that it exists so a bare
 * `Tooltip` can supply its own and still work when a screen mounts one on its own.
 */
const TooltipGroupContext = createContext(false);

export interface TooltipProviderProps {
  readonly children: ReactNode;
  /** How long the pointer must rest before a tooltip opens. */
  readonly delayDuration?: number;
}

/**
 * Groups tooltips so that moving between them stays instant (Radix's skip-delay behaviour).
 * Mount it once per app; without it each `Tooltip` brings its own provider.
 */
export function TooltipProvider({ children, delayDuration = 400 }: TooltipProviderProps) {
  return (
    <RadixTooltip.Provider delayDuration={delayDuration}>
      <TooltipGroupContext.Provider value={true}>{children}</TooltipGroupContext.Provider>
    </RadixTooltip.Provider>
  );
}

export interface TooltipProps {
  /** The trigger. Must be a single element that forwards props (`asChild`). */
  readonly children: ReactElement;
  /** Short, plain language, ≤ 12 words (11 §2). */
  readonly content: ReactNode;
  readonly side?: "top" | "right" | "bottom" | "left";
  readonly align?: "start" | "center" | "end";
  readonly sideOffset?: number;
  /** Only used when no `TooltipProvider` is mounted above. */
  readonly delayDuration?: number;
  /** Render the trigger without tooltip behaviour (e.g. while a popover is open). */
  readonly disabled?: boolean;
  /** Start open. Used by the workshop and the tests, never by the app. */
  readonly defaultOpen?: boolean;
  readonly className?: string;
}

/**
 * A styled Radix Tooltip. Tooltips never carry information that is not available another way
 * (11 §6): they repeat or expand the trigger's own label.
 */
export function Tooltip({
  children,
  content,
  side = "top",
  align = "center",
  sideOffset = 6,
  delayDuration = 400,
  disabled = false,
  defaultOpen = false,
  className,
}: TooltipProps) {
  const grouped = useContext(TooltipGroupContext);

  if (disabled) return children;

  const tooltip = (
    <RadixTooltip.Root defaultOpen={defaultOpen}>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          align={align}
          sideOffset={sideOffset}
          className={cx(styles.content, className)}
        >
          {content}
          <RadixTooltip.Arrow className={styles.arrow} width={10} height={5} />
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );

  if (grouped) return tooltip;

  return <RadixTooltip.Provider delayDuration={delayDuration}>{tooltip}</RadixTooltip.Provider>;
}
