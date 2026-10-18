/**
 * The committed colour-blind snapshots (acceptance 2): a machine-readable JSON file and an SVG
 * swatch sheet a human can look at. Both are generated from `tokens.json` and compared by
 * `cvd.test.ts`, so a palette change updates them or fails.
 */

import { simulated, VISIONS } from "./audit.js";
import { formatHex, parseColor, relativeLuminance } from "./color.js";
import { SIMULATION_LABELS, SIMULATIONS } from "./cvd.js";
import type { DesignTokens, ThemeName, ThemeTokens } from "./schema.js";

export interface CvdEntry {
  /** CSS variable name, as it appears in `tokens.css`. */
  readonly var: string;
  readonly normal: string;
  readonly protanopia: string;
  readonly deuteranopia: string;
  readonly tritanopia: string;
}

export interface CvdSnapshot {
  readonly generatedFrom: "packages/design/tokens.json";
  readonly method: "Machado, Oliveira & Fernandes (2009), severity 1.0, linear sRGB";
  readonly theme: ThemeName;
  readonly entries: readonly CvdEntry[];
}

export function cvdSnapshot(tokens: DesignTokens, theme: ThemeName): CvdSnapshot {
  return {
    generatedFrom: "packages/design/tokens.json",
    method: "Machado, Oliveira & Fernandes (2009), severity 1.0, linear sRGB",
    theme,
    entries: snapshotEntries(tokens.themes[theme]),
  };
}

export function cvdSnapshotJson(tokens: DesignTokens, theme: ThemeName): string {
  return `${JSON.stringify(cvdSnapshot(tokens, theme), null, 2)}\n`;
}

function snapshotEntries(theme: ThemeTokens): readonly CvdEntry[] {
  const entries: (readonly [string, string])[] = [
    ...Object.entries(theme.role).map(([name, value]) => [`--role-${name}`, value] as const),
    ...Object.entries(theme.section.fill).map(
      ([name, value]) => [`--section-fill-${name}`, value] as const,
    ),
    ...theme.energy.map((value, index) => [`--energy-stop-${index + 1}`, value] as const),
  ];

  return entries.map(([name, value]) => ({
    var: name,
    normal: formatHex(simulated(value, "normal")),
    protanopia: formatHex(simulated(value, "protanopia")),
    deuteranopia: formatHex(simulated(value, "deuteranopia")),
    tritanopia: formatHex(simulated(value, "tritanopia")),
  }));
}

const COLUMN_WIDTH = 132;
const LABEL_WIDTH = 176;
const ROW_HEIGHT = 40;
const SWATCH_HEIGHT = 26;

/** A swatch sheet: one row per colour, one column per vision. */
export function cvdSvg(tokens: DesignTokens, theme: ThemeName): string {
  const entries = snapshotEntries(tokens.themes[theme]);
  const width = LABEL_WIDTH + COLUMN_WIDTH * VISIONS.length;
  const height = 64 + entries.length * ROW_HEIGHT + 24;

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Bragi ${theme} theme colours under colour-blind simulation">`,
    `<rect width="${width}" height="${height}" fill="#14171f"/>`,
    `<text x="16" y="28" font-family="ui-monospace, monospace" font-size="15" fill="#f2f4f8">Bragi design tokens — ${theme} theme</text>`,
    `<text x="16" y="46" font-family="ui-monospace, monospace" font-size="10" fill="#9aa3b2">Machado et al. (2009) severity 1.0 · generated from tokens.json</text>`,
  ];

  VISIONS.forEach((vision, index) => {
    const x = LABEL_WIDTH + index * COLUMN_WIDTH;
    const label = vision === "normal" ? "normal vision" : vision;
    parts.push(
      `<text x="${x}" y="46" font-family="ui-monospace, monospace" font-size="10" fill="#9aa3b2">${label}</text>`,
    );
  });

  entries.forEach((entry, row) => {
    const y = 64 + row * ROW_HEIGHT;
    parts.push(
      `<text x="16" y="${y + 18}" font-family="ui-monospace, monospace" font-size="11" fill="#c9d1dd">${escapeXml(entry.var)}</text>`,
    );
    VISIONS.forEach((vision, column) => {
      const hex = entry[vision];
      const x = LABEL_WIDTH + column * COLUMN_WIDTH;
      parts.push(
        `<rect x="${x}" y="${y}" width="${COLUMN_WIDTH - 12}" height="${SWATCH_HEIGHT}" rx="4" fill="${hex}"/>`,
        `<text x="${x + 8}" y="${y + 17}" font-family="ui-monospace, monospace" font-size="10" fill="${textOn(hex)}">${hex}</text>`,
      );
    });
  });

  const legend = SIMULATIONS.map((simulation) => SIMULATION_LABELS[simulation]).join(" · ");
  parts.push(
    `<text x="16" y="${height - 8}" font-family="ui-monospace, monospace" font-size="9" fill="#7d8798">${escapeXml(legend)}</text>`,
  );

  return `${parts.join("\n")}\n</svg>\n`;
}

export function cvdSvgPath(theme: ThemeName): string {
  return `snapshots/cvd/${theme}.svg`;
}

export function cvdJsonPath(theme: ThemeName): string {
  return `snapshots/cvd/${theme}.json`;
}

function textOn(hex: string): string {
  return relativeLuminance(parseColor(hex)) > 0.35 ? "#14171f" : "#f2f4f8";
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
