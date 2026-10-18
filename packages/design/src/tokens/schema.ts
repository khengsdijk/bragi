/**
 * The shape of `tokens.json`, plus a parser that rejects a hand-edited file that has drifted.
 *
 * `tokens.json` is the only hand-edited token source; this module is how every consumer
 * (the CSS generator, the audits, the tests) reads it without trusting it.
 */

import { parseColor } from "./color.js";
import { SIMULATIONS, type Simulation } from "./cvd.js";

/** Unmodified vision plus the three Machado simulations the snapshots cover. */
export type VisionKey = "normal" | Simulation;

export const VISION_KEYS: readonly VisionKey[] = ["normal", ...SIMULATIONS];

export interface FontTokens {
  readonly sans: string;
  readonly mono: string;
  readonly fallbackSans: string;
  readonly fallbackMono: string;
}

export interface TypeTokens {
  /** Body size in `rem`, so text follows the user's browser/OS font size (11 §6.4, 200 %). */
  readonly baseRem: number;
  /** Modular scale ratio (11 §3: base 14 px, scale 1.2). */
  readonly ratio: number;
  /** Step name → exponent applied to `ratio`. */
  readonly steps: Readonly<Record<string, number>>;
  readonly leading: Readonly<Record<string, number>>;
  readonly weights: Readonly<Record<string, number>>;
}

export interface SpaceTokens {
  /** The grid in px (11 §3: a 4 px grid). */
  readonly unitPx: number;
  /** Step name → multiple of `unitPx`. Names are the multiple, e.g. `"4"` → `1rem`. */
  readonly steps: Readonly<Record<string, number>>;
}

export interface RadiusTokens {
  /** Step name → px, or a raw CSS length for values that are not lengths on the grid (a pill). */
  readonly steps: Readonly<Record<string, number | string>>;
}

export interface SizeTokens {
  /** WCAG 2.2 SC 2.5.8 minimum target, in px (11 §6.4). */
  readonly hitTargetPx: number;
  /** Control heights in px. */
  readonly controlSmPx: number;
  readonly controlMdPx: number;
  readonly controlLgPx: number;
}

export interface MotionTokens {
  readonly fastMs: number;
  readonly baseMs: number;
  readonly slowMs: number;
  /** Lens morphs and zoom transitions (11 §3: 600 ms). */
  readonly lensMs: number;
  readonly easing: Readonly<Record<string, string>>;
}

export type ThemeName = "dark" | "light";

export interface SectionTokens {
  /** Label colour drawn on the section fills — checked as text against every fill. */
  readonly label: string;
  /** Section family → fill colour. Families are mapped from `SectionKind` in `mapping.ts`. */
  readonly fill: Readonly<Record<string, string>>;
}

export interface ThemeTokens {
  readonly color: Readonly<Record<string, string>>;
  /** Stem role → ribbon/chip colour. */
  readonly role: Readonly<Record<string, string>>;
  readonly section: SectionTokens;
  /** Energy skyline gradient stops, low → high. */
  readonly energy: readonly string[];
}

export interface ContrastPair {
  /** CSS variable name, or a prefix glob ending in `*` (e.g. `--role-*`). */
  readonly fg: string;
  readonly bg: string;
  /** A named threshold from `contrast.thresholds`, or a literal ratio. */
  readonly min: string | number;
  readonly note?: string;
}

export interface DecorativePair {
  readonly token: string;
  readonly bg: string;
  /** Still checked — "decorative" lowers the bar, it does not remove it. */
  readonly min: number;
  readonly reason: string;
}

export interface ContrastSpec {
  readonly thresholds: Readonly<Record<string, number>>;
  readonly pairs: readonly ContrastPair[];
  readonly decorative: readonly DecorativePair[];
}

/**
 * Minimum ΔE00 per vision. Simulation thresholds are lower than the unmodified one on purpose:
 * a dichromat genuinely has less to work with, which is exactly why 11 §3 requires a second
 * carrier (label, glyph, pattern) for every colour-coded element.
 */
export type VisionThresholds = Readonly<Record<VisionKey, number>>;

export interface DistinguishabilitySpec {
  /** Between any two role colours. */
  readonly roles: VisionThresholds;
  /** Between any two section fills. */
  readonly sections: VisionThresholds;
  /** Between adjacent energy stops. */
  readonly energyAdjacent: VisionThresholds;
}

export interface DesignTokens {
  readonly font: FontTokens;
  readonly type: TypeTokens;
  readonly space: SpaceTokens;
  readonly radius: RadiusTokens;
  readonly size: SizeTokens;
  readonly motion: MotionTokens;
  /** Stem role → pattern id (colour is never the only carrier, 11 §3). */
  readonly rolePatterns: Readonly<Record<string, string>>;
  readonly themes: Readonly<Record<ThemeName, ThemeTokens>>;
  readonly contrast: ContrastSpec;
  readonly distinguishability: DistinguishabilitySpec;
}

const THEME_NAMES: readonly ThemeName[] = ["dark", "light"];

/** Parse and validate the JSON in `tokens.json`. Throws with a path-qualified message. */
export function parseTokens(input: unknown): DesignTokens {
  const root = asRecord(input, "tokens.json");
  const font = asRecord(root.font, "font");
  const type = asRecord(root.type, "type");
  const space = asRecord(root.space, "space");
  const radius = asRecord(root.radius, "radius");
  const size = asRecord(root.size, "size");
  const motion = asRecord(root.motion, "motion");
  const themesRaw = asRecord(root.themes, "themes");
  const contrast = asRecord(root.contrast, "contrast");
  const distinguishability = asRecord(root.distinguishability, "distinguishability");

  const themes = Object.fromEntries(
    THEME_NAMES.map((name) => [
      name,
      parseTheme(asRecord(themesRaw[name], `themes.${name}`), name),
    ]),
  ) as Record<ThemeName, ThemeTokens>;

  const rolePatterns = asStringRecord(root.rolePatterns, "rolePatterns");
  for (const role of Object.keys(themes.dark.role)) {
    if (!(role in rolePatterns)) {
      throw new Error(`rolePatterns.${role}: every role needs a pattern id (11 §3)`);
    }
  }
  return {
    font: {
      sans: asString(font.sans, "font.sans"),
      mono: asString(font.mono, "font.mono"),
      fallbackSans: asString(font.fallbackSans, "font.fallbackSans"),
      fallbackMono: asString(font.fallbackMono, "font.fallbackMono"),
    },
    type: {
      baseRem: asNumber(type.baseRem, "type.baseRem"),
      ratio: asNumber(type.ratio, "type.ratio"),
      steps: asNumberRecord(type.steps, "type.steps"),
      leading: asNumberRecord(type.leading, "type.leading"),
      weights: asNumberRecord(type.weights, "type.weights"),
    },
    space: {
      unitPx: asNumber(space.unitPx, "space.unitPx"),
      steps: asNumberRecord(space.steps, "space.steps"),
    },
    radius: { steps: asNumberOrStringRecord(radius.steps, "radius.steps") },
    size: {
      hitTargetPx: asNumber(size.hitTargetPx, "size.hitTargetPx"),
      controlSmPx: asNumber(size.controlSmPx, "size.controlSmPx"),
      controlMdPx: asNumber(size.controlMdPx, "size.controlMdPx"),
      controlLgPx: asNumber(size.controlLgPx, "size.controlLgPx"),
    },
    motion: {
      fastMs: asNumber(motion.fastMs, "motion.fastMs"),
      baseMs: asNumber(motion.baseMs, "motion.baseMs"),
      slowMs: asNumber(motion.slowMs, "motion.slowMs"),
      lensMs: asNumber(motion.lensMs, "motion.lensMs"),
      easing: asStringRecord(motion.easing, "motion.easing"),
    },
    rolePatterns,
    themes,
    contrast: parseContrast(contrast),
    distinguishability: {
      roles: asVisionThresholds(distinguishability.roles, "distinguishability.roles"),
      sections: asVisionThresholds(distinguishability.sections, "distinguishability.sections"),
      energyAdjacent: asVisionThresholds(
        distinguishability.energyAdjacent,
        "distinguishability.energyAdjacent",
      ),
    },
  };
}

function asVisionThresholds(value: unknown, at: string): VisionThresholds {
  const record = asNumberRecord(value, at);
  for (const key of VISION_KEYS) {
    if (record[key] === undefined) throw new Error(`${at}.${key}: expected a ΔE00 threshold`);
  }
  return record as VisionThresholds;
}

function parseTheme(theme: Record<string, unknown>, name: ThemeName): ThemeTokens {
  const at = (key: string): string => `themes.${name}.${key}`;
  const color = asStringRecord(theme.color, at("color"));
  const role = asStringRecord(theme.role, at("role"));
  const section = asRecord(theme.section, at("section"));

  for (const [key, value] of Object.entries({ ...color, ...role })) {
    try {
      parseColor(value);
    } catch (error) {
      throw new Error(`${at("color")}.${key}: ${(error as Error).message}`);
    }
  }

  const energyRaw = theme.energy;
  if (!Array.isArray(energyRaw) || energyRaw.length < 2) {
    throw new Error(`${at("energy")}: expected at least two gradient stops`);
  }
  const energy = energyRaw.map((entry, index) => asColor(entry, `${at("energy")}[${index}]`));

  return {
    color,
    role,
    section: {
      label: asColor(section.label, `${at("section.label")}`),
      fill: asStringRecord(section.fill, `${at("section.fill")}`),
    },
    energy,
  };
}

function parseContrast(contrast: Record<string, unknown>): ContrastSpec {
  const pairsRaw = contrast.pairs;
  const decorativeRaw = contrast.decorative;
  if (!Array.isArray(pairsRaw)) throw new Error("contrast.pairs: expected an array");
  if (!Array.isArray(decorativeRaw)) throw new Error("contrast.decorative: expected an array");

  return {
    thresholds: asNumberRecord(contrast.thresholds, "contrast.thresholds"),
    pairs: pairsRaw.map((entry, index) => {
      const pair = asRecord(entry, `contrast.pairs[${index}]`);
      return {
        fg: asString(pair.fg, `contrast.pairs[${index}].fg`),
        bg: asString(pair.bg, `contrast.pairs[${index}].bg`),
        min:
          typeof pair.min === "number"
            ? pair.min
            : asString(pair.min, `contrast.pairs[${index}].min`),
        ...(typeof pair.note === "string" ? { note: pair.note } : {}),
      };
    }),
    decorative: decorativeRaw.map((entry, index) => {
      const pair = asRecord(entry, `contrast.decorative[${index}]`);
      return {
        token: asString(pair.token, `contrast.decorative[${index}].token`),
        bg: asString(pair.bg, `contrast.decorative[${index}].bg`),
        min: asNumber(pair.min, `contrast.decorative[${index}].min`),
        reason: asString(pair.reason, `contrast.decorative[${index}].reason`),
      };
    }),
  };
}

function asRecord(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${at}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, at: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${at}: expected a string`);
  return value;
}

function asColor(value: unknown, at: string): string {
  const text = asString(value, at);
  parseColor(text);
  return text;
}

function asNumber(value: unknown, at: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${at}: expected a number`);
  }
  return value;
}

function asStringRecord(value: unknown, at: string): Readonly<Record<string, string>> {
  const record = asRecord(value, at);
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, asString(entry, `${at}.${key}`)]),
  );
}

function asNumberRecord(value: unknown, at: string): Readonly<Record<string, number>> {
  const record = asRecord(value, at);
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, asNumber(entry, `${at}.${key}`)]),
  );
}

function asNumberOrStringRecord(
  value: unknown,
  at: string,
): Readonly<Record<string, number | string>> {
  const record = asRecord(value, at);
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [
      key,
      typeof entry === "number" ? asNumber(entry, `${at}.${key}`) : asString(entry, `${at}.${key}`),
    ]),
  );
}
