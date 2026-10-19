/**
 * The macro ("vibe slider") engine (03 §6.1, 07 §4.5).
 *
 * Pure document maths, no React: a slider value becomes an op batch (`macroBatch`), and a
 * document's current parameters become a slider value (`macroValue`). The definitions and the
 * catalogue are generated from `crates/bragi-dsp` by `pnpm schemas:gen`, so the app, the planner
 * and the validator read one source.
 *
 * The document changes only through the Song Store: these functions return an `OpBatch`, never a
 * mutated document (13 §1 rule 4).
 */
import type {
  FxInstance,
  FxScope,
  FxType,
  MacroCurvePoint,
  MacroDefinition,
  MacroId,
  Op,
  OpBatch,
  Project,
} from "@bragi/schemas";
import { FX_CATALOG, MACROS } from "@bragi/schemas";

import { type MessageKey, t } from "../../i18n/index.js";
import { ulid } from "../../lib/ulid.js";
import { newBatchId } from "../song/state/ops.js";

/** Where a macro lives: a track's chain or the master chain (02 §3.7). */
export type MacroScope =
  | { readonly kind: "track"; readonly trackId: string }
  | { readonly kind: "master" };

/** A curve point: `[macro value, parameter value]`. */
export type Curve = readonly MacroCurvePoint[];

/** The i18n name of each built-in macro, used in the history label. */
const MACRO_NAME_KEYS: Readonly<Record<string, MessageKey>> = {
  brightness: "song.macro.brightness",
  space: "song.macro.space",
  punch: "song.macro.punch",
  warmth: "song.macro.warmth",
  vintage: "song.macro.vintage",
  intensity: "song.macro.intensity",
  distance: "song.macro.distance",
};

/** The macro with `id`, or `undefined` when the catalogue does not define it. */
function findMacro(id: MacroId): MacroDefinition | undefined {
  return MACROS.macros.find((macro) => macro.id === id);
}

/** The chain a scope points at, or `null` when the track does not exist. */
function chainFor(doc: Project, scope: MacroScope): FxInstance[] | null {
  if (scope.kind === "master") return doc.arrangement.master.fx;
  return doc.tracks.find((track) => track.id === scope.trackId)?.fx ?? null;
}

/** The `fx.add` scope for a macro scope. */
function fxScope(scope: MacroScope): FxScope {
  return scope.kind === "master" ? { kind: "master" } : { kind: "track", trackId: scope.trackId };
}

/** Clamps `value` into `[min, max]`. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Whether a stored parameter differs from the target.
 *
 * The model prints an `f64` in its shortest round-trip form (`2.22` for `2.2199999999999998`),
 * so an exact comparison would call every second application a change. The threshold is far below
 * any musical step in the catalogue's curves.
 */
function differs(current: number | undefined, target: number): boolean {
  return current === undefined || Math.abs(current - target) > 1e-9;
}

/**
 * The catalogue defaults of `type` as a plain parameter map.
 *
 * Params without a numeric default (a routing target or a band list) are omitted: they are not
 * representable in `FxParams` and macros never drive them.
 */
export function catalogueDefaults(type: FxType): Readonly<Record<string, number>> {
  const entry = FX_CATALOG.fx[type];
  if (entry === undefined) return {};
  const defaults: Record<string, number> = {};
  for (const [name, spec] of Object.entries(entry.params)) {
    if (spec.type === "number") defaults[name] = spec.default;
  }
  return defaults;
}

/**
 * The parameter value at `x`, by linear interpolation between the curve's points.
 *
 * `x` outside the curve clamps to its first or last point.
 */
export function interpolate(curve: Curve, x: number): number {
  const first = curve[0];
  const last = curve[curve.length - 1];
  if (first === undefined || last === undefined) {
    throw new Error("a macro curve needs at least one point");
  }
  if (x <= first[0]) return first[1];
  for (let index = 1; index < curve.length; index += 1) {
    const left = curve[index - 1];
    const right = curve[index];
    if (left === undefined || right === undefined) continue;
    if (x > right[0]) continue;
    const dx = right[0] - left[0];
    if (dx === 0) return right[1];
    return left[1] + ((x - left[0]) / dx) * (right[1] - left[1]);
  }
  return last[1];
}

/**
 * The macro value whose curve maps to `y`: the piecewise-linear inverse of {@link interpolate}.
 *
 * `y` outside the curve clamps to the first or last point. For a non-monotonic curve the first
 * matching segment wins, which is enough for the catalogue's readout curves (all monotonic).
 */
export function invert(curve: Curve, y: number): number {
  const first = curve[0];
  const last = curve[curve.length - 1];
  if (first === undefined || last === undefined) {
    throw new Error("a macro curve needs at least one point");
  }
  const values = curve.map((point) => point[1]);
  const clamped = clamp(y, Math.min(...values), Math.max(...values));
  for (let index = 1; index < curve.length; index += 1) {
    const left = curve[index - 1];
    const right = curve[index];
    if (left === undefined || right === undefined) continue;
    const low = Math.min(left[1], right[1]);
    const high = Math.max(left[1], right[1]);
    if (left[1] === right[1] || clamped < low || clamped > high) continue;
    return left[0] + ((clamped - left[1]) / (right[1] - left[1])) * (right[0] - left[0]);
  }
  return clamped === first[1] ? first[0] : last[0];
}

/**
 * The slider value for `macroId` in `scope`, read from the document.
 *
 * It inverts the first drive curve whose parameter exists on a macro-owned instance, so the
 * slider shows the truth after undo or a manual edit in the expert drawer. `0` means neutral and
 * is also what an untouched scope reports.
 */
export function macroValue(doc: Project, scope: MacroScope, macroId: MacroId): number {
  const macro = findMacro(macroId);
  const chain = chainFor(doc, scope);
  if (macro === undefined || chain === null) return 0;
  for (const drive of macro.drives) {
    const instance = chain.find(
      (candidate) => candidate.type === drive.fx && candidate.macroOwned === macroId,
    );
    if (instance === undefined) continue;
    const value = instance.params[drive.param];
    if (value === undefined) continue;
    return clamp(invert(drive.curve, value), macro.range[0], macro.range[1]);
  }
  return 0;
}

/** The history label for a macro change, e.g. "Space on Drums". */
function batchLabel(doc: Project, scope: MacroScope, macroId: MacroId): string | null {
  const nameKey = MACRO_NAME_KEYS[macroId];
  if (nameKey === undefined) return null;
  const name =
    scope.kind === "master"
      ? t("song.macro.master")
      : doc.tracks.find((track) => track.id === scope.trackId)?.name;
  if (name === undefined) return null;
  return t("song.macro.label", { macro: t(nameKey), name });
}

/**
 * The op batch that moves `macroId` to `value` in `scope`.
 *
 * Each driven fx type is either updated in place (when the scope already holds an instance owned
 * by this macro) or appended as a new `macroOwned` instance with the catalogue defaults overlaid
 * with the driven parameters. Value 0 restores the driven parameters to their defaults but keeps
 * the instances, and a no-op returns `null` so history stays quiet.
 */
export function macroBatch(
  doc: Project,
  scope: MacroScope,
  macroId: MacroId,
  value: number,
  now: Date = new Date(),
): OpBatch | null {
  const macro = findMacro(macroId);
  const chain = chainFor(doc, scope);
  if (macro === undefined || chain === null) return null;
  const target = clamp(value, macro.range[0], macro.range[1]);
  const label = batchLabel(doc, scope, macroId);
  if (label === null) return null;

  /** The driven parameters per fx type, merged when a macro drives several params of one fx. */
  const groups = new Map<FxType, { params: Record<string, number>; mode?: number }>();
  for (const drive of macro.drives) {
    const group = groups.get(drive.fx) ?? { params: {} };
    group.params[drive.param] = interpolate(drive.curve, target);
    if (drive.mode !== undefined) group.mode = drive.mode;
    groups.set(drive.fx, group);
  }

  const ops: Op[] = [];
  for (const [type, group] of groups) {
    const patch: Record<string, number> = { ...group.params };
    if (group.mode !== undefined) patch.mode = group.mode;
    const instance = chain.find(
      (candidate) => candidate.type === type && candidate.macroOwned === macroId,
    );
    if (instance !== undefined) {
      const changed = Object.entries(patch).some(([name, param]) =>
        differs(instance.params[name], param),
      );
      if (changed) ops.push({ op: "fx.update", fxId: instance.id, paramsPatch: patch });
      continue;
    }
    ops.push({
      op: "fx.add",
      scope: fxScope(scope),
      fx: {
        id: `fx_${ulid()}`,
        type,
        params: { ...catalogueDefaults(type), ...patch },
        bypass: false,
        macroOwned: macroId,
      },
    });
  }
  if (ops.length === 0) return null;
  return {
    id: newBatchId(),
    author: { kind: "user" },
    label,
    ops: ops as [Op, ...Op[]],
    createdAt: now.toISOString(),
  };
}
