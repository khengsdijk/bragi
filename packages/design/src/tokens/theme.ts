/**
 * Turn `tokens.json` into the flat CSS custom-property maps that `tokens.css` is made of, and
 * that the audits check. The naming of the CSS variables is defined here and nowhere else.
 */

import type { DesignTokens, ThemeName, ThemeTokens } from "./schema.js";

export interface Variable {
  readonly name: string;
  readonly value: string;
}

/** Convert `camelCase` / `snake_case` token keys to kebab-case CSS names. */
export function kebab(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
}

/** Round to at most 4 decimals and drop trailing zeros, so output is stable across engines. */
export function round(value: number, decimals = 4): number {
  return Number(value.toFixed(decimals));
}

export function rem(px: number): string {
  return `${round(px / 16, 4)}rem`;
}

/**
 * Theme-independent variables: families, the modular type scale, the spacing grid, radii,
 * control sizes and motion.
 */
export function baseVariables(tokens: DesignTokens): readonly Variable[] {
  const { type, space, radius, size, motion, font } = tokens;
  const variables: Variable[] = [
    { name: "--font-sans", value: `${font.sans}, ${font.fallbackSans}` },
    { name: "--font-mono", value: `"${font.mono}", ${font.fallbackMono}` },
  ];

  for (const [step, exponent] of sortedEntries(type.steps)) {
    variables.push({
      name: `--text-${step}`,
      value: `${round(type.baseRem * type.ratio ** exponent)}rem`,
    });
  }
  for (const [name, value] of sortedEntries(type.leading)) {
    variables.push({ name: `--leading-${name}`, value: String(value) });
  }
  for (const [name, value] of sortedEntries(type.weights)) {
    variables.push({ name: `--weight-${name}`, value: String(value) });
  }

  for (const [step, multiple] of sortedNumericEntries(space.steps)) {
    variables.push({ name: `--space-${step}`, value: rem(space.unitPx * multiple) });
  }

  for (const [step, px] of sortedEntries(radius.steps)) {
    variables.push({ name: `--radius-${step}`, value: typeof px === "number" ? rem(px) : px });
  }

  variables.push(
    { name: "--size-hit-target", value: rem(size.hitTargetPx) },
    { name: "--size-control-sm", value: rem(size.controlSmPx) },
    { name: "--size-control-md", value: rem(size.controlMdPx) },
    { name: "--size-control-lg", value: rem(size.controlLgPx) },
    { name: "--motion-fast", value: `${motion.fastMs}ms` },
    { name: "--motion-base", value: `${motion.baseMs}ms` },
    { name: "--motion-slow", value: `${motion.slowMs}ms` },
    { name: "--motion-lens", value: `${motion.lensMs}ms` },
  );

  for (const [name, value] of sortedEntries(motion.easing)) {
    variables.push({ name: `--ease-${name}`, value });
  }

  return variables;
}

/** Colours for one theme: UI colours, role colours, section fills and the energy gradient. */
export function themeVariables(theme: ThemeTokens): readonly Variable[] {
  const variables: Variable[] = [];

  for (const [key, value] of sortedEntries(theme.color)) {
    variables.push({ name: `--color-${kebab(key)}`, value });
  }
  for (const [role, value] of sortedEntries(theme.role)) {
    variables.push({ name: `--role-${kebab(role)}`, value });
  }
  variables.push({ name: "--section-label", value: theme.section.label });
  for (const [family, value] of sortedEntries(theme.section.fill)) {
    variables.push({ name: `--section-fill-${kebab(family)}`, value });
  }
  theme.energy.forEach((value, index) => {
    variables.push({ name: `--energy-stop-${index + 1}`, value });
  });

  return variables;
}

/** The names a contrast/colour check may refer to in a given theme. */
export function colourVariables(theme: ThemeTokens): ReadonlyMap<string, string> {
  return new Map(themeVariables(theme).map((variable) => [variable.name, variable.value]));
}

export function themeColours(tokens: DesignTokens, theme: ThemeName): ReadonlyMap<string, string> {
  return colourVariables(tokens.themes[theme]);
}

function sortedEntries<T extends string | number>(
  record: Readonly<Record<string, T>>,
): [string, T][] {
  return Object.entries(record).sort(([a], [b]) => a.localeCompare(b));
}

function sortedNumericEntries(record: Readonly<Record<string, number>>): [string, number][] {
  return Object.entries(record).sort(([a], [b]) => Number(a) - Number(b));
}
