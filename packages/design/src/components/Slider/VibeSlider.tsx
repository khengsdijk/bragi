import { Slider as RadixSlider } from "radix-ui";
import { type KeyboardEvent, type PointerEvent, useId, useRef } from "react";

import { cssVars, cx } from "../css.js";
import styles from "./Slider.module.css";
import { clamp, percentOf, quantise } from "./slider-utils.js";

/** Keys that put a bipolar slider back in the middle, exactly. */
const RESET_KEYS = new Set(["0", "Delete", "Backspace"]);

export interface VibeSliderProps {
  /** −1 … +1, with 0 in the middle. */
  readonly value: number;
  readonly onValueChange: (value: number) => void;
  readonly onValueCommit?: (value: number) => void;
  /** Visible label, e.g. "Brightness". */
  readonly label: string;
  /** The two ends, e.g. `["Darker", "Brighter"]` (11 §2). */
  readonly endLabels: readonly [string, string];
  /**
   * What a screen reader says for a value. Required: Simple mode shows words, not numbers
   * (11 §5), and `aria-valuetext` is the only thing that carries that.
   */
  readonly getValueText: (value: number) => string;
  readonly step?: number;
  /**
   * Pointer detent: a drag that lands closer to the middle than this snaps to exactly 0, so the
   * neutral setting can be found by feel. Keyboard steps are never detented.
   */
  readonly detent?: number;
  readonly disabled?: boolean;
  readonly className?: string;
}

/**
 * The bipolar "vibe" slider: Darker↔Brighter, Dry↔Spacious, Soft↔Punchy and friends
 * ([07 §4.5](../../../../specs/07-song-canvas.md), [03 §6.1](../../../../specs/03-audio-engine.md)).
 *
 * The fill grows out of the centre so the neutral position is visible, the middle is a detent
 * for the pointer and an exact grid point for the keyboard, and `0`, `Delete` or `Backspace`
 * resets to it.
 */
export function VibeSlider({
  value,
  onValueChange,
  onValueCommit,
  label,
  endLabels,
  getValueText,
  step = 0.05,
  detent = 0.05,
  disabled = false,
  className,
}: VibeSliderProps) {
  const labelId = useId();
  const pointerActive = useRef(false);
  const valueText = getValueText(value);

  const report = (next: number): number => {
    const snapped = pointerActive.current && Math.abs(next) < detent ? 0 : next;
    return quantise(snapped, -1, step);
  };

  const fillStart = Math.min(50, percentOf(value, -1, 1));
  const fillEnd = 100 - Math.max(50, percentOf(value, -1, 1));

  const handleKeyDown = (event: KeyboardEvent<HTMLSpanElement>): void => {
    if (!RESET_KEYS.has(event.key)) return;
    event.preventDefault();
    onValueChange(0);
    onValueCommit?.(0);
  };

  const handlePointerDown = (_event: PointerEvent<HTMLSpanElement>): void => {
    pointerActive.current = true;
  };

  const stopPointer = (): void => {
    pointerActive.current = false;
  };

  return (
    <div className={cx(styles.field, className)}>
      <div className={styles.header}>
        <span className={styles.label} id={labelId}>
          {label}
        </span>
      </div>
      <RadixSlider.Root
        className={styles.root}
        min={-1}
        max={1}
        step={step}
        value={[clamp(value, -1, 1)]}
        disabled={disabled}
        orientation="horizontal"
        onKeyDown={handleKeyDown}
        onPointerDown={handlePointerDown}
        onPointerUp={stopPointer}
        onPointerCancel={stopPointer}
        onLostPointerCapture={stopPointer}
        onValueChange={(values) => {
          const next = values[0];
          if (next !== undefined) onValueChange(report(next));
        }}
        {...(onValueCommit === undefined
          ? {}
          : {
              onValueCommit: (values: number[]) => {
                const next = values[0];
                if (next !== undefined) onValueCommit(report(next));
              },
            })}
      >
        <RadixSlider.Track className={styles.track}>
          <span
            className={styles.fill}
            style={cssVars({ "--fill-start": `${fillStart}%`, "--fill-end": `${fillEnd}%` })}
          />
          <span className={styles.centre} aria-hidden="true" />
          <RadixSlider.Thumb
            className={styles.thumb}
            aria-labelledby={labelId}
            aria-valuetext={valueText}
          />
        </RadixSlider.Track>
      </RadixSlider.Root>
      <div className={styles.ends}>
        <span className={value < 0 ? styles.endActive : undefined}>{endLabels[0]}</span>
        <span className={value > 0 ? styles.endActive : undefined}>{endLabels[1]}</span>
      </div>
    </div>
  );
}
