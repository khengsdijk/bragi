/**
 * The Inspector's names for catalogue data (07 §4.5, 03 §6).
 *
 * The catalogue gives ids, ranges and defaults, not copy: `mode` values and effect/parameter
 * names are localised here, in one place, so the expert drawer can stay generated. The effect
 * records cover every `FxType`, so adding a catalogue kind is a compile error until it gets a
 * name.
 */
import type { FxType, MacroDefinition, MacroId } from "@bragi/schemas";
import { MACROS } from "@bragi/schemas";

import { type MessageKey, t } from "../../i18n/index.js";
import { macroNameKey } from "./macros.js";

/** The short plain-language name of every effect kind. */
const EFFECT_KEYS: Readonly<Record<FxType, MessageKey>> = {
  eq3: "inspector.effect.eq3",
  filter: "inspector.effect.filter",
  compressor: "inspector.effect.compressor",
  saturation: "inspector.effect.saturation",
  reverb: "inspector.effect.reverb",
  delay: "inspector.effect.delay",
  width: "inspector.effect.width",
  gain: "inspector.effect.gain",
  transient: "inspector.effect.transient",
  lofi: "inspector.effect.lofi",
  chorus: "inspector.effect.chorus",
  sidechain_duck: "inspector.effect.sidechain_duck",
  match_eq: "inspector.effect.match_eq",
  limiter: "inspector.effect.limiter",
};

/** Parameter names by catalogue key. A missing entry falls back to the key itself. */
const PARAM_KEYS: Readonly<Record<string, MessageKey>> = {
  db: "inspector.param.db",
  lowDb: "inspector.param.lowDb",
  midDb: "inspector.param.midDb",
  highDb: "inspector.param.highDb",
  lowHz: "inspector.param.lowHz",
  midHz: "inspector.param.midHz",
  highHz: "inspector.param.highHz",
  midQ: "inspector.param.midQ",
  mode: "inspector.param.mode",
  cutoffHz: "inspector.param.cutoffHz",
  resonance: "inspector.param.resonance",
  thresholdDb: "inspector.param.thresholdDb",
  ratio: "inspector.param.ratio",
  attackMs: "inspector.param.attackMs",
  releaseMs: "inspector.param.releaseMs",
  makeupDb: "inspector.param.makeupDb",
  mix: "inspector.param.mix",
  drive: "inspector.param.drive",
  tone: "inspector.param.tone",
  size: "inspector.param.size",
  decaySec: "inspector.param.decaySec",
  predelayMs: "inspector.param.predelayMs",
  damping: "inspector.param.damping",
  timeBeats: "inspector.param.timeBeats",
  feedback: "inspector.param.feedback",
  pingPong: "inspector.param.pingPong",
  width: "inspector.param.width",
  attack: "inspector.param.attack",
  sustain: "inspector.param.sustain",
  bits: "inspector.param.bits",
  rateHz: "inspector.param.rateHz",
  wow: "inspector.param.wow",
  noise: "inspector.param.noise",
  depth: "inspector.param.depth",
  sourceTrack: "inspector.param.sourceTrack",
  amountDb: "inspector.param.amountDb",
  bands: "inspector.param.bands",
  amount: "inspector.param.amount",
  ceilingDb: "inspector.param.ceilingDb",
};

/** The `filter.mode` values in catalogue order (03 §6: 0 = LP, 1 = HP, 2 = BP). */
const MODE_KEYS: Readonly<Record<string, readonly MessageKey[]>> = {
  filter: ["inspector.mode.lowpass", "inspector.mode.highpass", "inspector.mode.bandpass"],
};

/** The i18n name of an effect kind. */
export function effectName(type: FxType): string {
  return t(EFFECT_KEYS[type]);
}

/** The i18n name of a catalogue parameter. */
export function paramName(name: string): string {
  const key = PARAM_KEYS[name];
  return key === undefined ? name : t(key);
}

/** The label for one value of a discrete `mode` parameter, or its index when unnamed. */
export function modeName(type: FxType, index: number): string {
  const key = MODE_KEYS[type]?.[index];
  return key === undefined ? String(index) : t(key);
}

/** The short name of a macro, e.g. "Brightness", for labels and the controlled-by chip. */
export function macroName(macroId: MacroId): string {
  const key = macroNameKey(macroId);
  return key === null ? macroId : t(key);
}

/** The two ends of a macro's plain-language pair, e.g. `["Darker", "Brighter"]`. */
export function macroPoles(macro: MacroDefinition): readonly [string, string] {
  const [left, right] = macro.label.split("↔").map((part) => part.trim());
  return [left ?? macro.label, right ?? macro.label];
}

/** The six vibe sliders of 07 §4.5, in catalogue order. `intensity` is not one of them. */
const VIBE_IDS: ReadonlySet<string> = new Set([
  "brightness",
  "space",
  "punch",
  "warmth",
  "vintage",
  "distance",
]);

/** The macros the track and master inspectors show as vibe sliders. */
export function vibeMacros(): readonly MacroDefinition[] {
  return MACROS.macros.filter((macro) => VIBE_IDS.has(macro.id));
}
