/**
 * The renderer's colours, taken from the design tokens (11 §3) rather than restated here.
 *
 * Two ways in, one result: {@link paletteFromTokens} reads a theme out of `tokens.json` (tests,
 * snapshots, the desktop shell) and {@link paletteFromReader} reads CSS custom properties off the
 * page (so the canvas follows `data-theme` with no second source of truth). `tokens.css` is
 * generated from `tokens.json`, so the two agree by construction.
 */
import {
  parseColor,
  ROLE_TOKEN_LIST,
  type RoleToken,
  SECTION_FAMILY_LIST,
  type SectionFamily,
  type ThemeTokens,
} from "@bragi/design/tokens";

import type { ChordSegment } from "./types.js";

export interface Palette {
  readonly theme: "dark" | "light";
  readonly canvas: number;
  readonly surface: number;
  readonly surfaceRaised: number;
  readonly line: number;
  readonly lineStrong: number;
  readonly text: number;
  readonly textMuted: number;
  readonly accent: number;
  readonly focus: number;
  readonly warning: number;
  readonly roles: Readonly<Record<RoleToken, number>>;
  readonly sectionFill: Readonly<Record<SectionFamily, number>>;
  readonly sectionLabel: number;
  /** Energy gradient stops, low to high. */
  readonly energy: readonly number[];
  readonly fontSans: string;
}

/** `#rrggbb` (or `#rrggbbaa`) to `0xRRGGBB`. */
export function hexToNumber(hex: string): number {
  const { r, g, b } = parseColor(hex.trim());
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
}

/** `0xRRGGBB` to channel bytes. */
export function numberToRgb(color: number): [number, number, number] {
  return [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff];
}

/** Linear mix of two colours, `t` = 0 gives `a`. */
export function mixColors(a: number, b: number, t: number): number {
  const [ar, ag, ab] = numberToRgb(a);
  const [br, bg, bb] = numberToRgb(b);
  const mix = (x: number, y: number): number => Math.round(x + (y - x) * t);
  return (mix(ar, br) << 16) | (mix(ag, bg) << 8) | mix(ab, bb);
}

const EMPTY_FONT = "system-ui, sans-serif";

/** The palette for one theme of `tokens.json`. */
export function paletteFromTokens(
  theme: ThemeTokens,
  name: "dark" | "light",
  fontSans = EMPTY_FONT,
): Palette {
  const color = (key: string): number => hexToNumber(theme.color[key] ?? "#ff00ff");
  const roles = {} as Record<RoleToken, number>;
  for (const role of ROLE_TOKEN_LIST) roles[role] = hexToNumber(theme.role[role] ?? "#ff00ff");
  const sectionFill = {} as Record<SectionFamily, number>;
  for (const family of SECTION_FAMILY_LIST) {
    sectionFill[family] = hexToNumber(theme.section.fill[family] ?? "#ff00ff");
  }
  return {
    theme: name,
    canvas: color("canvas"),
    surface: color("surface"),
    surfaceRaised: color("surfaceRaised"),
    line: color("line"),
    lineStrong: color("lineStrong"),
    text: color("text"),
    textMuted: color("textMuted"),
    accent: color("accent"),
    focus: color("focus"),
    warning: color("warning"),
    roles,
    sectionFill,
    sectionLabel: hexToNumber(theme.section.label),
    energy: theme.energy.map(hexToNumber),
    fontSans,
  };
}

/** The palette from CSS custom properties (`--color-canvas`, `--role-drums`, ...). */
export function paletteFromReader(
  read: (name: string) => string,
  name: "dark" | "light",
  fontSans = EMPTY_FONT,
): Palette {
  const css = (variable: string): number => hexToNumber(read(variable) || "#ff00ff");
  const roles = {} as Record<RoleToken, number>;
  for (const role of ROLE_TOKEN_LIST) roles[role] = css(`--role-${role}`);
  const sectionFill = {} as Record<SectionFamily, number>;
  for (const family of SECTION_FAMILY_LIST) sectionFill[family] = css(`--section-fill-${family}`);
  return {
    theme: name,
    canvas: css("--color-canvas"),
    surface: css("--color-surface"),
    surfaceRaised: css("--color-surface-raised"),
    line: css("--color-line"),
    lineStrong: css("--color-line-strong"),
    text: css("--color-text"),
    textMuted: css("--color-text-muted"),
    accent: css("--color-accent"),
    focus: css("--color-focus"),
    warning: css("--color-warning"),
    roles,
    sectionFill,
    sectionLabel: css("--section-label"),
    energy: [1, 2, 3, 4, 5].map((stop) => css(`--energy-stop-${stop}`)),
    fontSans,
  };
}

/** The energy gradient colour at `value` (0..1), interpolated between the stops. */
export function energyColor(palette: Palette, value: number): number {
  const stops = palette.energy;
  const clamped = Math.min(1, Math.max(0, value));
  const scaled = clamped * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(scaled));
  return mixColors(stops[index] ?? 0, stops[index + 1] ?? 0, scaled - index);
}

/** HSL (h in degrees, s and l in 0..1) to `0xRRGGBB`. */
export function hslToNumber(h: number, s: number, l: number): number {
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number): number => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return (
    (Math.round(channel(0) * 255) << 16) |
    (Math.round(channel(8) * 255) << 8) |
    Math.round(channel(4) * 255)
  );
}

/**
 * A chord segment's fill (07 §2): hue = root on the circle of fifths (so related keys sit next to
 * each other), lightness = major (light) or minor (dark), saturation drops for diminished and
 * suspended chords. The lightness bands flip with the theme so the label on top keeps its contrast.
 */
export function chordFill(
  chord: Pick<ChordSegment, "rootPitchClass" | "quality">,
  theme: "dark" | "light",
): number {
  const hue = ((chord.rootPitchClass * 7) % 12) * 30;
  const saturation = chord.quality === "diminished" || chord.quality === "suspended" ? 0.22 : 0.58;
  const major = chord.quality === "major" || chord.quality === "suspended";
  const lightness = theme === "dark" ? (major ? 0.72 : 0.38) : major ? 0.34 : 0.7;
  return hslToNumber(hue, saturation, lightness);
}

/** Black or white text, whichever reads better on `fill` (WCAG relative luminance). */
export function readableOn(fill: number): number {
  const [r, g, b] = numberToRgb(fill).map((value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.38 ? 0x10141c : 0xf6f8fc;
}
