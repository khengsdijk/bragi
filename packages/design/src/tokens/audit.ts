/**
 * Token audits: the WCAG contrast check (acceptance 1) and the colour-blind
 * distinguishability check (acceptance 2). Shared by the test suite and `tokens:report`.
 */

import { composite, contrastRatio, parseColor, type Rgba, round2, toLab } from "./color.js";
import { simulate } from "./cvd.js";
import { ciede2000 } from "./deltae.js";
import type { DesignTokens, ThemeName, VisionThresholds } from "./schema.js";
import { colourVariables, themeColours } from "./theme.js";

export const THEMES: readonly ThemeName[] = ["dark", "light"];

export const VISIONS = ["normal", "protanopia", "deuteranopia", "tritanopia"] as const;

export type Vision = (typeof VISIONS)[number];

export interface ContrastRow {
  readonly theme: ThemeName;
  readonly fg: string;
  readonly bg: string;
  readonly ratio: number;
  readonly required: number;
  readonly ok: boolean;
  readonly note?: string;
}

/** A pair entry is a literal variable name or a prefix glob (`--role-*`). */
export function matches(pattern: string, name: string): boolean {
  return pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : pattern === name;
}

export function expand(pattern: string, names: Iterable<string>): readonly string[] {
  return [...names].filter((name) => matches(pattern, name)).sort();
}

function requiredRatio(tokens: DesignTokens, min: string | number): number {
  if (typeof min === "number") return min;
  const value = tokens.contrast.thresholds[min];
  if (value === undefined) {
    throw new Error(
      `contrast.thresholds.${min}: undefined threshold (known: ${Object.keys(tokens.contrast.thresholds).join(", ")})`,
    );
  }
  return value;
}

/**
 * Every declared pairing, in both themes, expanded and measured. The foreground is composited
 * over the background first, so translucent tokens (the scrim) are measured as drawn.
 */
export function contrastRows(tokens: DesignTokens): readonly ContrastRow[] {
  const rows: ContrastRow[] = [];

  for (const theme of THEMES) {
    const names = [...themeColours(tokens, theme).keys()];

    for (const pair of tokens.contrast.pairs) {
      const required = requiredRatio(tokens, pair.min);
      const fgNames = expand(pair.fg, names);
      const bgNames = expand(pair.bg, names);
      if (fgNames.length === 0 || bgNames.length === 0) {
        throw new Error(
          `contrast pair ${pair.fg} on ${pair.bg}: matched nothing (fg: ${fgNames.length}, bg: ${bgNames.length})`,
        );
      }
      for (const fgName of fgNames) {
        for (const bgName of bgNames) {
          const bg = tokenColour(tokens, theme, bgName);
          const fg = composite(tokenColour(tokens, theme, fgName), bg);
          const ratio = round2(contrastRatio(fg, bg));
          rows.push({
            theme,
            fg: fgName,
            bg: bgName,
            ratio,
            required,
            ok: ratio >= required,
            ...(pair.note === undefined ? {} : { note: pair.note }),
          });
        }
      }
    }

    for (const entry of tokens.contrast.decorative) {
      const bg = tokenColour(tokens, theme, entry.bg);
      const fg = composite(tokenColour(tokens, theme, entry.token), bg);
      const ratio = round2(contrastRatio(fg, bg));
      rows.push({
        theme,
        fg: entry.token,
        bg: entry.bg,
        ratio,
        required: entry.min,
        ok: ratio >= entry.min,
        note: `decorative: ${entry.reason}`,
      });
    }
  }

  return rows;
}

export interface CoverageGap {
  readonly theme: ThemeName;
  readonly token: string;
}

/** Colour tokens that no pairing mentions — an invitation to add a token with no proof. */
export function coverageGaps(tokens: DesignTokens): readonly CoverageGap[] {
  const gaps: CoverageGap[] = [];
  for (const theme of THEMES) {
    const names = [...themeColours(tokens, theme).keys()];
    const mentioned = new Set<string>();
    for (const pair of tokens.contrast.pairs) {
      for (const name of expand(pair.fg, names)) mentioned.add(name);
      for (const name of expand(pair.bg, names)) mentioned.add(name);
    }
    for (const entry of tokens.contrast.decorative) mentioned.add(entry.token);
    for (const name of names) {
      if (!mentioned.has(name)) gaps.push({ theme, token: name });
    }
  }
  return gaps;
}

export type Group = "roles" | "sections" | "energy";

export interface DistinguishabilityRow {
  readonly theme: ThemeName;
  readonly group: Group;
  /** `normal` is unmodified vision; the rest are Machado severity-1.0 simulations. */
  readonly vision: Vision;
  readonly min: number;
  readonly threshold: number;
  readonly ok: boolean;
  /** The closest pair in that vision, for the report. */
  readonly pair: readonly [string, string];
}

export function distinguishabilityRows(tokens: DesignTokens): readonly DistinguishabilityRow[] {
  const rows: DistinguishabilityRow[] = [];

  for (const theme of THEMES) {
    const surface = tokens.themes[theme];
    const stops = surface.energy.map(
      (value, index) => [`--energy-stop-${index + 1}`, value] as const,
    );
    const adjacent: (readonly [string, string])[] = [];
    for (let index = 1; index < stops.length; index += 1) {
      const previous = stops[index - 1];
      const current = stops[index];
      if (previous !== undefined && current !== undefined) adjacent.push([previous[0], current[0]]);
    }

    rows.push(
      ...measure(theme, "roles", Object.entries(surface.role), tokens.distinguishability.roles),
      ...measure(
        theme,
        "sections",
        Object.entries(surface.section.fill),
        tokens.distinguishability.sections,
      ),
      ...measure(theme, "energy", stops, tokens.distinguishability.energyAdjacent, adjacent),
    );
  }

  return rows;
}

function measure(
  theme: ThemeName,
  group: Group,
  entries: readonly (readonly [string, string])[],
  thresholds: VisionThresholds,
  pairs?: readonly (readonly [string, string])[],
): readonly DistinguishabilityRow[] {
  const lookup = new Map(entries);
  const considered = pairs ?? allPairs(entries.map(([name]) => name));
  const rows: DistinguishabilityRow[] = [];

  for (const vision of VISIONS) {
    const threshold = thresholds[vision];
    let min = Number.POSITIVE_INFINITY;
    let worst: readonly [string, string] = ["", ""];
    for (const [a, b] of considered) {
      const first = lookup.get(a);
      const second = lookup.get(b);
      if (first === undefined || second === undefined) continue;
      const difference = ciede2000(labOf(first, vision), labOf(second, vision));
      if (difference < min) {
        min = difference;
        worst = [a, b];
      }
    }
    rows.push({
      theme,
      group,
      vision,
      min: round2(min),
      threshold,
      ok: min >= threshold,
      pair: worst,
    });
  }

  return rows;
}

function allPairs(names: readonly string[]): readonly (readonly [string, string])[] {
  const pairs: (readonly [string, string])[] = [];
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      const a = names[i];
      const b = names[j];
      if (a !== undefined && b !== undefined) pairs.push([a, b]);
    }
  }
  return pairs;
}

/** A colour token as it appears under one vision (unmodified for `normal`). */
export function simulated(hex: string, vision: Vision): Rgba {
  const colour = parseColor(hex);
  return vision === "normal" ? colour : simulate(colour, vision);
}

function labOf(hex: string, vision: Vision): ReturnType<typeof toLab> {
  return toLab(simulated(hex, vision));
}

export function tokenColour(tokens: DesignTokens, theme: ThemeName, name: string): Rgba {
  const value = colourVariables(tokens.themes[theme]).get(name);
  if (value === undefined) throw new Error(`${theme}: unknown colour token ${name}`);
  return parseColor(value);
}
