/**
 * Local suggestion chips for the prompt bar (07 §4.3).
 *
 * v1 has no generation, so every chip names an ops-only lever the planner can apply to the
 * selected instruments: tone, space, level, lo-fi or remove. The chips are picked from the region's
 * roles — one instrument gets its own vocabulary, several instruments (or the whole song) get the
 * mixed set. Pure, so the rules are unit-tested and the component only translates the keys.
 */
import type { StemRole } from "@bragi/render-canvas";

import type { MessageKey } from "../../i18n/index.js";

export interface SuggestionContext {
  /** The roles of the instruments the region covers, in document order. */
  readonly roles: readonly StemRole[];
  readonly trackCount: number;
  readonly sectionCount: number;
  /** No selection and the whole timeline: the "Whole song" path (07 §8). */
  readonly wholeSong: boolean;
}

const DRUMS: readonly MessageKey[] = [
  "planner.chip.halfTime",
  "planner.chip.moreLofi",
  "planner.chip.quieter",
  "planner.chip.remove",
];

const VOCALS: readonly MessageKey[] = [
  "planner.chip.moreReverb",
  "planner.chip.quieter",
  "planner.chip.remove",
  "planner.chip.moreSpace",
];

const BASS: readonly MessageKey[] = [
  "planner.chip.warmer",
  "planner.chip.quieter",
  "planner.chip.remove",
  "planner.chip.morePunch",
];

const KEYS: readonly MessageKey[] = [
  "planner.chip.warmer",
  "planner.chip.brighter",
  "planner.chip.moreSpace",
  "planner.chip.remove",
];

const SYNTH: readonly MessageKey[] = [
  "planner.chip.brighter",
  "planner.chip.moreSpace",
  "planner.chip.warmer",
  "planner.chip.remove",
];

const MIXED: readonly MessageKey[] = [
  "planner.chip.warmer",
  "planner.chip.brighter",
  "planner.chip.moreSpace",
  "planner.chip.quieter",
];

/** One instrument's vocabulary; unknown roles fall back to the mixed set. */
function forRole(role: StemRole): readonly MessageKey[] {
  switch (role) {
    case "drums":
      return DRUMS;
    case "vocals":
      return VOCALS;
    case "bass":
      return BASS;
    case "guitar":
    case "piano":
    case "strings":
    case "recorded":
      return KEYS;
    case "synth":
      return SYNTH;
    default:
      return MIXED;
  }
}

/**
 * The chips for a region. A single instrument in a single part gets its role's levers; several
 * instruments, several parts or the whole song get the mixed set.
 */
export function suggestionChips(context: SuggestionContext): readonly MessageKey[] {
  const role = context.roles[0];
  if (context.wholeSong || context.trackCount > 1 || context.sectionCount > 1) return MIXED;
  if (context.trackCount === 0 || role === undefined) return MIXED;
  return forRole(role);
}
