/**
 * Brush stroke → one op batch (07 §4.4, WP-2.4).
 *
 * Every instant brush commits exactly one batch on stroke end. A brush never changes the
 * document itself: it returns `OpBatch`, which the history store applies (13 §1 rule 4). The
 * macro brushes reuse the WP-2.3 macro engine, so the fx they shape are the same `macroOwned`
 * instances the vibe sliders create and a second stroke updates them instead of adding more.
 *
 * Lane automation is **section-relative** and lives per section × track (02 §3.8), so a region
 * that spans two sections writes one `automation.set` per section with ticks relative to that
 * section. Existing points inside the stroke (including its ramps) are replaced; points outside
 * stay, because `automation.set` only replaces the tick range its points span (02 §4.2).
 *
 * Edge ramps are at least 50 ms (07 §4.4, §10 check 3). The length is computed from the
 * document's tempo map: `bragi-model` owns the conversion, but a batch is built *before* it is
 * applied and the Song Store owns the wasm handle, so the same tempo-map maths runs here in
 * TypeScript, exactly like the section maths in `song/state/section-ops.ts`.
 */
import type {
  AutomationCurve,
  AutomationPoint,
  FxInstance,
  MacroId,
  Op,
  OpBatch,
  Project,
  Region,
  SectionInstance,
  Track,
} from "@bragi/schemas";
import { MACROS } from "@bragi/schemas";

import { type MessageKey, t } from "../../i18n/index.js";
import { ulid } from "../../lib/ulid.js";
import {
  catalogueDefaults,
  interpolate,
  type MacroScope,
  macroBatch,
} from "../inspector/macros.js";
import type { ModelApi } from "../song/model/model-api.js";
import { newBatchId } from "../song/state/ops.js";
import { meterAt } from "../song/state/section-ops.js";
import type { BrushId, BrushParams, FilterDirection } from "./types.js";

/** The automation edge ramp (07 §4.4: 50 ms at the stroke edges). */
export const MIN_RAMP_SEC = 0.05;

/** The filter brush's open end and its closed end at full strength. */
const FILTER_PASS_HZ = 20_000;
const FILTER_LOW_HZ = 300;

/** How far Louder/Quieter move the fader at full strength. */
const GAIN_SPAN_DB = 12;

/** The built-in macro each macro brush drives. Darker uses the same macro on the negative side. */
const BRUSH_MACROS: Readonly<Partial<Record<BrushId, MacroId>>> = {
  space: "space",
  warmth: "warmth",
  brighter: "brightness",
  darker: "brightness",
};

/** One section's share of the region, in absolute and section-relative ticks. */
interface Slice {
  readonly section: SectionInstance;
  readonly startTick: number;
  readonly endTick: number;
  readonly startRel: number;
  readonly endRel: number;
  readonly lengthTicks: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** The tracks a region names, de-duplicated in the region's order (`"all"` expands). */
function regionTrackIds(doc: Project, region: Region): string[] {
  const ids = region.tracks === "all" ? doc.tracks.map((track) => track.id) : region.tracks;
  return [...new Set(ids)];
}

/** The sections the region overlaps, split into their own relative-tick share. */
function regionSlices(doc: Project, region: Region): Slice[] {
  const slices: Slice[] = [];
  let startTick = 0;
  for (const section of doc.arrangement.sections) {
    const endTick = startTick + section.lengthTicks;
    const sliceStart = Math.max(region.startTick, startTick);
    const sliceEnd = Math.min(region.endTick, endTick);
    if (sliceStart < sliceEnd) {
      slices.push({
        section,
        startTick: sliceStart,
        endTick: sliceEnd,
        startRel: sliceStart - startTick,
        endRel: sliceEnd - startTick,
        lengthTicks: section.lengthTicks,
      });
    }
    startTick = endTick;
  }
  return slices;
}

// --- tempo map ----------------------------------------------------------------------------------

interface TempoSegment {
  readonly tick: number;
  readonly bpm: number;
  readonly curve: "step" | "linear";
}

/** The tempo map sorted by tick (02 §2.2: the first point is at 0). */
function tempoSegments(doc: Project): TempoSegment[] {
  return [...doc.arrangement.timebase.tempoMap].sort((a, b) => a.tick - b.tick);
}

/** Seconds in `[start, end]` under one tempo segment, integrating a linear bpm ramp exactly. */
function segmentSeconds(
  doc: Project,
  start: number,
  end: number,
  bpm: number,
  curve: "step" | "linear",
  nextBpm: number | undefined,
): number {
  const ticks = end - start;
  if (ticks <= 0) return 0;
  const secondsPerTick = 60 / (doc.arrangement.timebase.ppq * bpm);
  if (curve === "linear" && nextBpm !== undefined && nextBpm !== bpm) {
    return ((secondsPerTick * ticks) / (nextBpm - bpm)) * Math.log(nextBpm / bpm);
  }
  return secondsPerTick * ticks;
}

/** Seconds elapsed at `ticks`, from the tempo map (the same integral `bragi-model` performs). */
function secondsAtTicks(doc: Project, ticks: number): number {
  const segments = tempoSegments(doc);
  const first = segments[0];
  if (first === undefined) return 0;

  let seconds = 0;
  let cursor = first.tick;
  for (const [index, segment] of segments.entries()) {
    if (ticks <= cursor) break;
    const next = segments[index + 1];
    const segmentEnd = Math.min(ticks, next?.tick ?? ticks);
    seconds += segmentSeconds(doc, cursor, segmentEnd, segment.bpm, segment.curve, next?.bpm);
    if (next === undefined || ticks <= next.tick) break;
    cursor = next.tick;
  }
  return seconds;
}

/** The bpm in force at `tick`, interpolated on a linear tempo segment. */
function bpmAt(doc: Project, tick: number): number {
  const segments = tempoSegments(doc);
  const first = segments[0];
  if (first === undefined) return 120;
  let current = first;
  for (const segment of segments) {
    if (segment.tick > tick) break;
    current = segment;
  }
  const next = segments[segments.indexOf(current) + 1];
  if (current.curve !== "linear" || next === undefined) return current.bpm;
  const span = next.tick - current.tick;
  if (span <= 0) return next.bpm;
  const fraction = clamp((tick - current.tick) / span, 0, 1);
  return current.bpm + fraction * (next.bpm - current.bpm);
}

/**
 * Ticks a 50 ms edge ramp takes at `tick`'s local tempo, rounded up.
 *
 * The tempo-map integral is checked against {@link MIN_RAMP_SEC}, so a linear tempo ramp
 * between the two ends can never make the edge one tick too short.
 */
export function rampTicksAt(doc: Project, tick: number): number {
  const startSec = secondsAtTicks(doc, tick);
  const ppq = doc.arrangement.timebase.ppq;
  let ramp = Math.max(1, Math.ceil((MIN_RAMP_SEC * bpmAt(doc, tick) * ppq) / 60));
  while (secondsAtTicks(doc, tick + ramp) - startSec < MIN_RAMP_SEC + 1e-9 && ramp < ppq * 4) {
    ramp += 1;
  }
  return ramp;
}

// --- automation ---------------------------------------------------------------------------------

/** The automation entry a lane already holds for `target`, if any. */
function existingPoints(
  doc: Project,
  sectionId: string,
  trackId: string,
  target: string,
): readonly AutomationPoint[] {
  const section = doc.arrangement.sections.find((candidate) => candidate.id === sectionId);
  return section?.lanes[trackId]?.automation.find((entry) => entry.target === target)?.points ?? [];
}

/** The value of `points` at a section-relative `tick`, following each point's curve. */
function automationValue(
  points: readonly AutomationPoint[],
  tick: number,
  fallback: number,
): number {
  const first = points[0];
  if (first === undefined) return fallback;
  if (tick <= first.tick) return first.value;

  for (let index = 1; index < points.length; index += 1) {
    const left = points[index - 1];
    const right = points[index];
    if (left === undefined || right === undefined || tick > right.tick) continue;
    const span = right.tick - left.tick;
    if (span <= 0) return right.value;
    const fraction = (tick - left.tick) / span;
    if (left.curve === "step") return left.value;
    if (left.curve === "exp" && left.value > 0 && right.value > 0) {
      return left.value * (right.value / left.value) ** fraction;
    }
    return left.value + fraction * (right.value - left.value);
  }
  return points[points.length - 1]?.value ?? fallback;
}

/**
 * The points one section lane gets for a target: an edge ramp in (first slice), the hold or
 * sweep across the slice, and an edge ramp out (last slice). Points are section-relative.
 */
function slicePoints(
  doc: Project,
  slice: Slice,
  first: boolean,
  last: boolean,
  trackId: string,
  target: string,
  baseline: number,
  inside: (absoluteTick: number) => number,
  insideCurve: AutomationCurve,
): AutomationPoint[] {
  const points: AutomationPoint[] = [];
  const current = (relativeTick: number): number =>
    automationValue(existingPoints(doc, slice.section.id, trackId, target), relativeTick, baseline);

  if (first) {
    const ramp = rampTicksAt(doc, slice.startTick);
    const rampStart = Math.max(0, slice.startRel - ramp);
    points.push({ tick: rampStart, value: current(rampStart), curve: "linear" });
  }
  points.push({
    tick: slice.startRel,
    value: inside(slice.startTick),
    curve: insideCurve,
  });
  if (slice.endRel > slice.startRel) {
    points.push({ tick: slice.endRel, value: inside(slice.endTick), curve: "linear" });
  }
  if (last) {
    const ramp = rampTicksAt(doc, slice.endTick);
    const rampEnd = Math.min(slice.lengthTicks, slice.endRel + ramp);
    // With no room left in the section the ramp cannot exist; keep the hold's last point.
    if (rampEnd > slice.endRel) {
      points.push({ tick: rampEnd, value: current(rampEnd), curve: "step" });
    }
  }

  // A ramp that has no room starts at the region edge; the target at that tick wins.
  const byTick = new Map<number, AutomationPoint>();
  for (const point of points) byTick.set(point.tick, point);
  return [...byTick.values()].sort((a, b) => a.tick - b.tick);
}

/** Appends one `automation.set` per section slice for a target on one track. */
function addAutomation(
  ops: Op[],
  doc: Project,
  slices: readonly Slice[],
  trackId: string,
  target: string,
  baseline: number,
  inside: (absoluteTick: number) => number,
  insideCurve: AutomationCurve,
): void {
  for (const [index, slice] of slices.entries()) {
    const points = slicePoints(
      doc,
      slice,
      index === 0,
      index === slices.length - 1,
      trackId,
      target,
      baseline,
      inside,
      insideCurve,
    );
    if (points.length === 0) continue;
    ops.push({
      op: "automation.set",
      scope: { kind: "lane", sectionId: slice.section.id, trackId },
      target,
      points,
    });
  }
}

/** The value a track's lane shows at `tick` before the stroke, for relative gain moves. */
function currentValue(
  doc: Project,
  slice: Slice,
  trackId: string,
  target: string,
  relativeTick: number,
  baseline: number,
): number {
  return automationValue(
    existingPoints(doc, slice.section.id, trackId, target),
    relativeTick,
    baseline,
  );
}

// --- brush families -----------------------------------------------------------------------------

/**
 * Space/Warmth/Brighter/Darker: create the macro's fx at neutral (the WP-2.3 `macroBatch`), then
 * automate every parameter the macro drives to the curve at `value`.
 */
function addMacroBrush(
  ops: Op[],
  doc: Project,
  slices: readonly Slice[],
  trackIds: readonly string[],
  macroId: MacroId,
  value: number,
  now: Date,
): void {
  const macro = MACROS.macros.find((candidate) => candidate.id === macroId);
  if (macro === undefined) return;

  for (const trackId of trackIds) {
    const track = doc.tracks.find((candidate) => candidate.id === trackId);
    if (track === undefined) continue;
    const scope: MacroScope = { kind: "track", trackId };
    const neutral = macroBatch(doc, scope, macroId, 0, now);
    if (neutral !== null) ops.push(...neutral.ops);

    const added = new Map<string, string>();
    for (const op of neutral?.ops ?? []) {
      if (op.op === "fx.add") added.set(op.fx.type, op.fx.id);
    }

    for (const drive of macro.drives) {
      const fxId =
        added.get(drive.fx) ??
        track.fx.find((instance) => instance.type === drive.fx && instance.macroOwned === macroId)
          ?.id;
      if (fxId === undefined) continue;
      addAutomation(
        ops,
        doc,
        slices,
        trackId,
        `fx:${fxId}/${drive.param}`,
        interpolate(drive.curve, 0),
        () => interpolate(drive.curve, value),
        "linear",
      );
    }
  }
}

/** Louder/Quieter: the fader moves by up to 12 dB from its current value, with the same ramps. */
function addGainBrush(
  ops: Op[],
  doc: Project,
  slices: readonly Slice[],
  trackIds: readonly string[],
  deltaDb: number,
): void {
  for (const trackId of trackIds) {
    const track = doc.tracks.find((candidate) => candidate.id === trackId);
    const first = slices[0];
    if (track === undefined || first === undefined) continue;
    const target = `track:${trackId}/gainDb`;
    const atStart = currentValue(doc, first, trackId, target, first.startRel, track.gainDb);
    const value = atStart + deltaDb;
    addAutomation(ops, doc, slices, trackId, target, track.gainDb, () => value, "linear");
  }
}

/** The track's own `filter` (not one a macro owns), or a new low-pass instance. */
function ensureFilter(ops: Op[], track: Track): FxInstance {
  const existing = track.fx.find(
    (instance) => instance.type === "filter" && instance.macroOwned === undefined,
  );
  if (existing !== undefined) {
    if (existing.params.mode !== 0) {
      ops.push({ op: "fx.update", fxId: existing.id, paramsPatch: { mode: 0 } });
    }
    return existing;
  }
  const fx: FxInstance = {
    id: `fx_${ulid()}`,
    type: "filter",
    params: { ...catalogueDefaults("filter"), mode: 0 },
    bypass: false,
  };
  ops.push({ op: "fx.add", scope: { kind: "track", trackId: track.id }, fx });
  return fx;
}

/** The track's own `lofi` at `mix = 0`, or a new instance (the Lo-fi brush's carrier). */
function ensureLofi(ops: Op[], track: Track): FxInstance {
  const existing = track.fx.find(
    (instance) => instance.type === "lofi" && instance.macroOwned === undefined,
  );
  if (existing !== undefined) {
    if (existing.params.mix !== 0) {
      ops.push({ op: "fx.update", fxId: existing.id, paramsPatch: { mix: 0 } });
    }
    return existing;
  }
  const fx: FxInstance = {
    id: `fx_${ulid()}`,
    type: "lofi",
    params: { ...catalogueDefaults("lofi"), mix: 0 },
    bypass: false,
  };
  ops.push({ op: "fx.add", scope: { kind: "track", trackId: track.id }, fx });
  return fx;
}

/**
 * Filter sweep: a low-pass per track whose cutoff travels across the region, exponential in Hz.
 *
 * Strength sets how far it closes: at full strength it reaches 300 Hz, at half the geometric
 * middle (≈2.4 kHz), and the region's edges open back to 20 kHz (07 §4.4, 02 §3.7).
 */
function addFilterSweep(
  ops: Op[],
  doc: Project,
  region: Region,
  slices: readonly Slice[],
  trackIds: readonly string[],
  strength: number,
  direction: FilterDirection,
): void {
  const low = FILTER_LOW_HZ * (FILTER_PASS_HZ / FILTER_LOW_HZ) ** (1 - strength);
  const span = Math.max(1, region.endTick - region.startTick);
  const cutoffAt = (tick: number): number => {
    const fraction = clamp((tick - region.startTick) / span, 0, 1);
    return direction === "up"
      ? low * (FILTER_PASS_HZ / low) ** fraction
      : FILTER_PASS_HZ * (low / FILTER_PASS_HZ) ** fraction;
  };

  for (const trackId of trackIds) {
    const track = doc.tracks.find((candidate) => candidate.id === trackId);
    if (track === undefined) continue;
    const fx = ensureFilter(ops, track);
    addAutomation(
      ops,
      doc,
      slices,
      trackId,
      `fx:${fx.id}/cutoffHz`,
      FILTER_PASS_HZ,
      cutoffAt,
      "exp",
    );
  }
}

/** Lo-fi: a track `lofi` fx whose `mix` rises to the stroke strength (plan §A decision). */
function addLofi(
  ops: Op[],
  doc: Project,
  slices: readonly Slice[],
  trackIds: readonly string[],
  strength: number,
): void {
  for (const trackId of trackIds) {
    const track = doc.tracks.find((candidate) => candidate.id === trackId);
    if (track === undefined) continue;
    const fx = ensureLofi(ops, track);
    addAutomation(ops, doc, slices, trackId, `fx:${fx.id}/mix`, 0, () => strength, "linear");
  }
}

// --- label --------------------------------------------------------------------------------------

/** "Drums", "Drums and Bass", "Drums, Bass and Pads" (11 §2: plain language). */
function trackNames(doc: Project, trackIds: readonly string[]): string {
  const names = trackIds.map((id) => doc.tracks.find((track) => track.id === id)?.name ?? id);
  const last = names[names.length - 1];
  if (last === undefined) return "";
  if (names.length === 1) return last;
  return t("brush.tracks.and", { list: names.slice(0, -1).join(", "), last });
}

/** The history label, e.g. "Space on Drums, bars 9–12" (11 §2). */
function brushLabel(doc: Project, brush: BrushId, region: Region): string {
  const from = meterAt(doc, region.startTick).bar + 1;
  const to = meterAt(doc, Math.max(region.startTick, region.endTick - 1)).bar + 1;
  const brushName = t(`brush.name.${brush}` as MessageKey);
  const tracks = trackNames(doc, regionTrackIds(doc, region));
  return from === to
    ? t("brush.batch.bar", { brush: brushName, tracks, bar: from })
    : t("brush.batch.label", { brush: brushName, tracks, from, to });
}

// --- entry point --------------------------------------------------------------------------------

/**
 * One brush stroke as one op batch, or `null` when there is nothing to do (empty region, zero
 * strength, no track in the region).
 *
 * `model` is part of the signature because task B's controller owns the Song Store handle; the
 * batch itself is pure over the document, so the 50 ms conversion uses the tempo map directly
 * (see {@link rampTicksAt}).
 */
export function brushBatch(
  doc: Project,
  brush: BrushId,
  params: BrushParams,
  _model: ModelApi,
  now: Date = new Date(),
): OpBatch | null {
  const region = params.region;
  const strength = clamp(params.strength, 0, 1);
  if (region.startTick >= region.endTick || strength <= 0) return null;
  const trackIds = regionTrackIds(doc, region);
  if (trackIds.length === 0) return null;
  const slices = regionSlices(doc, region);
  if (slices.length === 0) return null;

  const ops: Op[] = [];
  const macroId = BRUSH_MACROS[brush];
  if (macroId !== undefined) {
    addMacroBrush(
      ops,
      doc,
      slices,
      trackIds,
      macroId,
      brush === "darker" ? -strength : strength,
      now,
    );
  } else if (brush === "louder" || brush === "quieter") {
    addGainBrush(
      ops,
      doc,
      slices,
      trackIds,
      (brush === "louder" ? 1 : -1) * GAIN_SPAN_DB * strength,
    );
  } else if (brush === "filterSweep") {
    addFilterSweep(ops, doc, region, slices, trackIds, strength, params.direction ?? "up");
  } else if (brush === "lofi") {
    addLofi(ops, doc, slices, trackIds, strength);
  } else if (brush === "remove") {
    ops.push({ op: "region.clear", region });
  }

  if (ops.length === 0) return null;
  return {
    id: newBatchId(),
    author: { kind: "user" },
    label: brushLabel(doc, brush, region),
    ops: ops as [Op, ...Op[]],
    createdAt: now.toISOString(),
  };
}
