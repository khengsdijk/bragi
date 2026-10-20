/**
 * Value text for the Inspector's sliders (11 §2, §5): plain words and the units a musician
 * already reads on hardware. Every negative number uses a true minus sign (−), never a hyphen.
 */
import type { CatalogNumberParam } from "@bragi/schemas";

import { t } from "../../i18n/index.js";

/** U+2212 MINUS SIGN, so value text never reads like a range. */
const MINUS = "\u2212";

/** `−3.0 dB`, or `0.0 dB` at unity. */
export function formatDb(value: number): string {
  const rounded = Math.abs(value) < 0.05 ? 0 : value;
  const magnitude = Math.abs(rounded).toFixed(1);
  return `${rounded < 0 ? `${MINUS}${magnitude}` : magnitude} ${t("inspector.unit.db")}`;
}

/** `800 Hz` or `12 kHz`. */
export function formatHz(value: number): string {
  if (value >= 1000) {
    const khz = value / 1000;
    const decimals = khz >= 10 ? 0 : 1;
    return `${khz.toFixed(decimals)} ${t("inspector.unit.khz")}`;
  }
  return `${Math.round(value)} ${t("inspector.unit.hz")}`;
}

/** `10 ms`, or `0.5 ms` below 1. */
export function formatMs(value: number): string {
  const decimals = value < 10 ? 1 : 0;
  return `${value.toFixed(decimals)} ${t("inspector.unit.ms")}`;
}

/** `2.0 s`, or `0.25 s` below 1. */
export function formatSec(value: number): string {
  const decimals = value < 1 ? 2 : 1;
  return `${value.toFixed(decimals)} ${t("inspector.unit.sec")}`;
}

/** `40%`. */
export function formatPercent(value: number): string {
  return `${Math.round(value * 100)}${t("inspector.unit.percent")}`;
}

/** `4.0:1`, from the compressor's ratio. */
export function formatRatio(value: number): string {
  return t("inspector.value.ratio", { value: value.toFixed(1) });
}

/** A tempo-synced delay as a note value (`1/4`), or beats when it is not a binary division. */
export function formatNoteValue(beats: number): string {
  const denominator = 4 / beats;
  if (Number.isInteger(denominator) && denominator >= 1 && denominator <= 64) {
    return t("inspector.value.note", { denominator });
  }
  return t("inspector.value.beats", { value: beats.toFixed(2) });
}

/** `1.00×` for stereo width. */
export function formatWidth(value: number): string {
  return t("inspector.value.width", { value: value.toFixed(2) });
}

/** Pan as words: `20% left`, `Centre`, `20% right`. */
export function formatPan(value: number): string {
  const percent = Math.round(Math.abs(value) * 100);
  if (percent === 0) return t("inspector.pan.centre");
  return value < 0 ? t("inspector.pan.left", { percent }) : t("inspector.pan.right", { percent });
}

/** A vibe slider's value: `40% darker` or `Unchanged` at the centre. */
export function formatVibe(value: number, endLabels: readonly [string, string]): string {
  const percent = Math.round(Math.abs(value) * 100);
  if (percent === 0) return t("inspector.vibe.centre");
  return t("inspector.vibe.side", {
    side: value < 0 ? endLabels[0] : endLabels[1],
    percent,
  });
}

/** The unit text for one catalogue parameter. */
export function formatParamValue(name: string, value: number, spec: CatalogNumberParam): string {
  if (name.endsWith("Db") || name === "db") return formatDb(value);
  if (name.endsWith("Hz")) return formatHz(value);
  if (name.endsWith("Ms")) return formatMs(value);
  if (name === "decaySec") return formatSec(value);
  if (name === "ratio") return formatRatio(value);
  if (name === "timeBeats") return formatNoteValue(value);
  if (name === "width") return formatWidth(value);
  if (name === "bits") return String(Math.round(value));
  if (name === "midQ") return value.toFixed(2);
  if (name === "pingPong") return formatPercent(value);
  if (spec.min >= -1 && spec.max <= 1) {
    // Bipolar shaping (transient, saturation tone) reads as a signed percentage; unipolar
    // amounts read as a plain share.
    if (spec.min < 0) {
      const percent = Math.round(value * 100);
      return `${percent > 0 ? "+" : percent < 0 ? MINUS : ""}${Math.abs(percent)}${t("inspector.unit.percent")}`;
    }
    return formatPercent(value);
  }
  return value.toFixed(2);
}

/** The natural step for a catalogue parameter. */
export function paramStep(name: string, spec: CatalogNumberParam): number {
  if (name === "mode" || name === "bits") return 1;
  if (name === "timeBeats") return 0.0625;
  if (name.endsWith("Db") || name === "db" || name === "ratio") return 0.1;
  if (name.endsWith("Hz")) return spec.max <= 20 ? 0.01 : 1;
  if (name.endsWith("Ms")) return spec.max <= 20 ? 0.1 : 1;
  if (name === "decaySec") return 0.01;
  if (spec.max - spec.min > 100) return 1;
  return 0.01;
}

/** Whether a numeric catalogue parameter is a small integer enum rather than a continuous value. */
export function isModeParam(name: string, spec: CatalogNumberParam): boolean {
  return (
    name === "mode" &&
    Number.isInteger(spec.min) &&
    Number.isInteger(spec.max) &&
    spec.max - spec.min <= 4
  );
}
