import { useId } from "react";

import { cx } from "../css.js";
import styles from "./SegmentedControl.module.css";

export interface SegmentedControlOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface SegmentedControlProps {
  /** Visible group label, e.g. "Mode". Required: a group without a name is unusable. */
  readonly label: string;
  readonly value: string;
  readonly options: readonly SegmentedControlOption[];
  readonly onChange: (value: string) => void;
  readonly className?: string;
}

/**
 * A compact radio group drawn as joined segments: the Inspector's `mode` parameters
 * ([07 §4.5](../../../../specs/07-song-canvas.md), [03 §6](../../../../specs/03-audio-engine.md)).
 *
 * Native radios carry the keyboard behaviour (arrows move within the group, Tab leaves it) and
 * the checked state, so no custom roving-focus code is needed. The selected segment is marked by
 * its fill and weight as well as colour (11 §3).
 */
export function SegmentedControl({
  label,
  value,
  options,
  onChange,
  className,
}: SegmentedControlProps) {
  const name = useId();

  return (
    <fieldset className={cx(styles.root, className)}>
      <legend className={styles.legend}>{label}</legend>
      <div className={styles.options}>
        {options.map((option) => {
          const checked = option.value === value;
          return (
            <label
              key={option.value}
              className={styles.option}
              data-checked={checked ? "true" : undefined}
              data-disabled={option.disabled === true ? "true" : undefined}
            >
              <input
                className={styles.input}
                type="radio"
                name={name}
                value={option.value}
                checked={checked}
                disabled={option.disabled === true}
                onChange={() => onChange(option.value)}
              />
              <span className={styles.text}>{option.label}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
