import type { CSSProperties } from "react";

/** CSS custom properties for an inline `style`. Keeps `as CSSProperties` out of components. */
export function cssVars(vars: Readonly<Record<string, string | number>>): CSSProperties {
  return vars as CSSProperties;
}

/** Concatenate class names, dropping empty ones. */
export function cx(...values: readonly (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(" ");
}
