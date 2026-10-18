import type { ReactNode } from "react";
import { roleVar, type SectionKind, type StemRole, sectionFillVar } from "../../tokens/mapping.js";
import { cssVars, cx } from "../css.js";
import styles from "./Chip.module.css";

export interface ChipProps {
  /**
   * The label. Always required: the text carries the meaning, the colour only reinforces it
   * (11 §3).
   */
  readonly children: ReactNode;
  /** Adds the role's swatch colour, e.g. on a suggestion chip for a stem. */
  readonly stemRole?: StemRole;
  /** Paints the chip in the section family's colour, for a section reference. */
  readonly sectionKind?: SectionKind;
  readonly tone?: "neutral" | "accent" | "danger";
  readonly selected?: boolean;
  /** Makes the chip a button. */
  readonly onSelect?: () => void;
  readonly icon?: ReactNode;
  /** Spoken name when the visible label is not enough (e.g. an abbreviated one). */
  readonly accessibleLabel?: string;
  readonly className?: string;
}

/**
 * A small label token: suggestion chips in the prompt bar, a section reference, the "✨ Smooth
 * with AI" chip on a new boundary ([07 §4.1](../../../../specs/07-song-canvas.md)).
 */
export function Chip({
  children,
  stemRole,
  sectionKind,
  tone = "neutral",
  selected = false,
  onSelect,
  icon,
  accessibleLabel,
  className,
}: ChipProps) {
  const content = (
    <>
      {stemRole === undefined ? null : (
        <span
          className={styles.swatch}
          style={cssVars({ "--swatch": roleVar(stemRole) })}
          aria-hidden="true"
        />
      )}
      {icon === undefined ? null : (
        <span className={styles.icon} aria-hidden="true">
          {icon}
        </span>
      )}
      <span className={styles.label}>{children}</span>
    </>
  );

  const shared = {
    className: cx(styles.chip, className),
    "data-tone": tone,
    "data-selected": selected ? "true" : undefined,
    ...(sectionKind === undefined
      ? {}
      : {
          "data-section": sectionKind,
          style: cssVars({ "--chip-fill": sectionFillVar(sectionKind) }),
        }),
  };

  if (onSelect === undefined) {
    return (
      <span
        {...shared}
        {...(accessibleLabel === undefined ? {} : { "aria-label": accessibleLabel })}
      >
        {content}
      </span>
    );
  }

  return (
    <button
      {...shared}
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      {...(accessibleLabel === undefined ? {} : { "aria-label": accessibleLabel })}
    >
      {content}
    </button>
  );
}
