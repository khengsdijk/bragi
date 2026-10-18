import { Slider as RadixSlider } from "radix-ui";
import { useId } from "react";

import { cssVars, cx } from "../css.js";
import styles from "./Slider.module.css";
import { percentOf, quantise } from "./slider-utils.js";

export interface SliderProps {
  readonly value: number;
  readonly onValueChange: (value: number) => void;
  /** Fired when a drag or key press finishes, for undo grouping. */
  readonly onValueCommit?: (value: number) => void;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  /** Visible label. Required: a slider without a name is unusable with a screen reader. */
  readonly label: string;
  /** Format the value for the readout and for `aria-valuetext`. */
  readonly formatValue?: (value: number) => string;
  /** Show the formatted value next to the label. Simple mode shows none (11 §5). */
  readonly showValue?: boolean;
  readonly disabled?: boolean;
  readonly className?: string;
}

/**
 * A unipolar slider on Radix's Slider. Keyboard: arrows step, PageUp/PageDown (or Shift+arrow)
 * jump ten steps, Home/End go to the ends. In Simple mode the app passes `formatValue` words
 * such as "louder" instead of numbers (11 §5).
 */
export function Slider({
  value,
  onValueChange,
  onValueCommit,
  min = 0,
  max = 1,
  step = 0.01,
  label,
  formatValue,
  showValue = false,
  disabled = false,
  className,
}: SliderProps) {
  const labelId = useId();
  const readout = formatValue === undefined ? undefined : formatValue(value);
  const fillEnd = 100 - percentOf(value, min, max);

  return (
    <div className={cx(styles.field, className)}>
      <div className={styles.header}>
        <span className={styles.label} id={labelId}>
          {label}
        </span>
        {showValue && readout !== undefined ? (
          <span className={cx(styles.value, "numeric")} aria-hidden="true">
            {readout}
          </span>
        ) : null}
      </div>
      <RadixSlider.Root
        className={styles.root}
        min={min}
        max={max}
        step={step}
        value={[value]}
        disabled={disabled}
        orientation="horizontal"
        onValueChange={(values) => {
          const next = values[0];
          if (next !== undefined) onValueChange(quantise(next, min, step));
        }}
        {...(onValueCommit === undefined
          ? {}
          : {
              onValueCommit: (values: number[]) => {
                const next = values[0];
                if (next !== undefined) onValueCommit(quantise(next, min, step));
              },
            })}
      >
        <RadixSlider.Track className={styles.track}>
          <span
            className={styles.fill}
            style={cssVars({ "--fill-start": "0%", "--fill-end": `${fillEnd}%` })}
          />
          <RadixSlider.Thumb
            className={styles.thumb}
            aria-labelledby={labelId}
            {...(readout === undefined ? {} : { "aria-valuetext": readout })}
          />
        </RadixSlider.Track>
      </RadixSlider.Root>
    </div>
  );
}
