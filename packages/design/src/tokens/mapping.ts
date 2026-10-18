/**
 * How the song model's vocabulary maps onto the design tokens.
 *
 * The unions below mirror [02 §3.4, §3.5](../../../../specs/02-song-model.md). They are written
 * out here because `@bragi/schemas` (WP-0.2) has not generated its types yet; when it has, these
 * become `import type { SectionKind, StemRole } from "@bragi/schemas"` and the tables stay.
 * Recorded as a deferral in `docs/wp/0.6.md`.
 */

/** [02 §3.5] */
export type SectionKind =
  | "intro"
  | "verse"
  | "pre_chorus"
  | "chorus"
  | "post_chorus"
  | "bridge"
  | "breakdown"
  | "build"
  | "drop"
  | "solo"
  | "interlude"
  | "outro"
  | "custom";

/** [02 §3.4] */
export type StemRole =
  | "vocals"
  | "drums"
  | "bass"
  | "guitar"
  | "piano"
  | "synth"
  | "strings"
  | "other"
  | "residual"
  | "full_mix"
  | "generated"
  | "fx"
  | "recorded";

/**
 * Section families. [11 §3] names hues for intro/outro, verse, chorus, bridge, drop and
 * breakdown; the remaining kinds join the nearest family so the palette stays small enough to
 * stay distinguishable (pre-chorus and post-chorus lean to chorus, build leans to drop,
 * solo/interlude/custom are neutral).
 */
export const SECTION_FAMILIES = {
  intro: "neutral",
  verse: "blue",
  pre_chorus: "warm",
  chorus: "warm",
  post_chorus: "warm",
  bridge: "purple",
  breakdown: "teal",
  build: "redorange",
  drop: "redorange",
  solo: "neutral",
  interlude: "neutral",
  outro: "neutral",
  custom: "neutral",
} as const satisfies Record<SectionKind, string>;

export type SectionFamily = (typeof SECTION_FAMILIES)[SectionKind];

/** Every family in a stable order, for stories and tests. */
export const SECTION_FAMILY_LIST = [
  "neutral",
  "blue",
  "warm",
  "purple",
  "redorange",
  "teal",
] as const;

/**
 * Stem roles → role colours. [11 §3] names nine; `other` aliases `synth`, `fx` aliases
 * `residual`, and the two reference roles (`full_mix`, `recorded`) use the neutral `residual`
 * slate until they need their own hue.
 */
export const ROLE_TOKENS = {
  vocals: "vocals",
  drums: "drums",
  bass: "bass",
  guitar: "guitar",
  piano: "piano",
  synth: "synth",
  other: "synth",
  strings: "strings",
  generated: "generated",
  residual: "residual",
  fx: "residual",
  full_mix: "residual",
  recorded: "residual",
} as const satisfies Record<StemRole, string>;

export type RoleToken = (typeof ROLE_TOKENS)[StemRole];

/** Every role in a stable order. */
export const ROLE_TOKEN_LIST = [
  "vocals",
  "drums",
  "bass",
  "guitar",
  "piano",
  "synth",
  "strings",
  "generated",
  "residual",
] as const;

export function sectionFillVar(kind: SectionKind): string {
  return `var(--section-fill-${SECTION_FAMILIES[kind]})`;
}

export function sectionFamilyOf(kind: SectionKind): SectionFamily {
  return SECTION_FAMILIES[kind];
}

export function roleVar(role: StemRole): string {
  return `var(--role-${ROLE_TOKENS[role]})`;
}

export function roleTokenOf(role: StemRole): RoleToken {
  return ROLE_TOKENS[role];
}
