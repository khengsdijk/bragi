/** Shared maths for `Slider` and `VibeSlider`. */

/** How many decimals the step is written with, so quantised values stay exact. */
export function stepDecimals(step: number): number {
  const text = String(step);
  const fraction = text.split(".")[1];
  return fraction === undefined ? 0 : fraction.length;
}

/**
 * Snap a value onto the `min + k * step` grid and round away the floating-point noise that
 * otherwise makes a keyboard step land on 2.2e-16 instead of 0.
 */
export function quantise(value: number, min: number, step: number): number {
  const steps = Math.round((value - min) / step);
  const decimals = Math.min(10, stepDecimals(step));
  return Number((min + steps * step).toFixed(decimals));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Position of a value along the range, as a percentage. */
export function percentOf(value: number, min: number, max: number): number {
  if (max === min) return 0;
  return ((clamp(value, min, max) - min) / (max - min)) * 100;
}
