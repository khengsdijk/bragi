/**
 * Op shapes for the planner prompt, derived from the generated op schemas (06 §2, §4).
 *
 * The tool schema sends ops loosely (the server validates every op precisely, 06 §5), so the
 * model needs the keys of each op somewhere. This module samples one minimal valid example per op
 * kind from `PLAN_TOOL_SCHEMA`, so the block cannot drift from `packages/schemas/song/ops/`.
 * The same samples render the "expected shape" in a validation error.
 *
 * Two op kinds are listed but not offered: their payload is a whole document object (a `Track`,
 * `SectionInstance` or `Clip` with IDs and asset hashes the summary does not carry) or a system
 * concern, so an ops-only planner cannot construct them safely.
 */
import { OP_NAMES, PLAN_TOOL_SCHEMA } from "@bragi/schemas";

/** A JSON object as the generated schemas store it. */
type JsonObject = Record<string, unknown>;

/** Op kinds the ops-only planner may use. The rest need a whole document object or are system ops. */
const NOT_PLANNER_OPS: ReadonlySet<string> = new Set([
  "analysis.apply", // system op: records an analysis stage
  "project.set_meta", // metadata, not a musical edit
  "track.add", // the payload is a complete Track (colour, ids, fx chain)
  "track.remove", // whole-track deletion; muting is track.update
  "section.insert", // the payload is a complete SectionInstance with lanes and clips
  "clip.add", // the payload is a complete Clip with a warp map and an asset hash
  "clip.replace", // the payload is a list of complete Clips
  "region.adopt", // needs a commit ID, and v1 carries none
]);

/** How deep a sample may recurse before it gives up on an optional structure. */
const MAX_DEPTH = 8;

/** The op definitions from the generated tool schema. */
let cachedDefinitions: ReadonlyMap<string, JsonObject> | undefined;

/** The `$defs` of the generated tool schema. */
function defs(): Record<string, unknown> {
  const value = PLAN_TOOL_SCHEMA.$defs;
  if (!isRecord(value)) throw new Error("PLAN_TOOL_SCHEMA has no $defs");
  return value;
}

/** Every op definition, keyed by its `op` discriminator. */
export function opDefinitions(): ReadonlyMap<string, JsonObject> {
  if (cachedDefinitions !== undefined) return cachedDefinitions;
  const definitions = defs();
  const opDef = definitions.Op;
  if (!isRecord(opDef) || !Array.isArray(opDef.oneOf)) {
    throw new Error("PLAN_TOOL_SCHEMA.$defs.Op is not a oneOf union");
  }
  const out = new Map<string, JsonObject>();
  for (const branch of opDef.oneOf) {
    if (!isRecord(branch) || typeof branch.$ref !== "string") continue;
    const name = branch.$ref.slice("#/$defs/".length);
    const definition = definitions[name];
    if (!isRecord(definition)) continue;
    const op = discriminator(definition);
    if (op !== undefined) out.set(op, definition);
  }
  cachedDefinitions = out;
  return out;
}

/** The op kinds the ops-only planner may use, in schema order. */
export function plannerOpNames(): string[] {
  return OP_NAMES.filter((op) => !NOT_PLANNER_OPS.has(op));
}

/** The string pattern of a generated definition, when it has one. */
function patternOf(name: string): string | undefined {
  const definition = defs()[name];
  return isRecord(definition) && typeof definition.pattern === "string"
    ? definition.pattern
    : undefined;
}

/** The `op` a generated definition names. */
function discriminator(definition: JsonObject): string | undefined {
  const op = definition.properties;
  if (!isRecord(op)) return undefined;
  const property = op.op;
  if (!isRecord(property)) return undefined;
  if (typeof property.$ref === "string" && property.$ref.startsWith("#/$defs/")) {
    const target = defs()[property.$ref.slice("#/$defs/".length)];
    if (isRecord(target) && Array.isArray(target.enum) && typeof target.enum[0] === "string") {
      return target.enum[0];
    }
  }
  if (Array.isArray(property.enum) && typeof property.enum[0] === "string") {
    return property.enum[0];
  }
  return undefined;
}

/**
 * A minimal valid example of one op.
 *
 * @param op an op discriminator from {@link plannerOpNames}
 * @returns the example, or undefined for an unknown op
 */
export function sampleOp(op: string): unknown {
  const definition = opDefinitions().get(op);
  if (definition === undefined) return undefined;
  const example = sample(definition, 0);
  // A one-tick resize or an empty source range is valid but reads as a mistake; four bars at
  // 960 PPQ is a normal edit.
  if (isRecord(example)) {
    if (op === "section.resize") example.lengthTicks = 15360;
    if (op === "clip.update" && isRecord(example.patch)) example.patch.srcEnd = 7680;
  }
  return example;
}

/** The compact block the planner puts in the user message. */
export function opShapesText(): string {
  const lines = plannerOpNames().map((op) => `  ${op} ${compact(sampleOp(op))}`);
  const fxId = patternOf("FxId");
  return [
    `OP SHAPES (generated; use exactly these keys; trk_1, sec_1, clp_1 and fx_1 are placeholders${
      fxId === undefined ? "" : `; a new fx id must match ${fxId} (no "_" after the prefix)`
    }):`,
    ...lines,
    "",
    "TIME-LIMITED REGION (track fx/mixer changes act on the whole song; add fx neutral, automate it on the section lane; lane ticks are section-relative):",
    `  ${compact(timeLimitedFx())}`,
    `  ${compact(timeLimitedAutomation())}`,
  ].join("\n");
}

/** The fx.add half of the time-limited pattern, using an fx type with a `cutoffHz` target. */
function timeLimitedFx(): unknown {
  const example = sampleOp("fx.add");
  if (isRecord(example) && isRecord(example.fx)) example.fx.type = "filter";
  return example;
}

/** The lane-automation half of the time-limited pattern, using the fx.add sample's id. */
function timeLimitedAutomation(): unknown {
  return {
    op: "automation.set",
    scope: { kind: "lane", sectionId: "sec_1", trackId: "trk_1" },
    target: "fx:fx_1/cutoffHz",
    points: [
      { tick: 0, value: 18000, curve: "linear" },
      { tick: 15360, value: 900, curve: "linear" },
    ],
  };
}

/**
 * The expected value(s) for one property of an op, as the repair round reads it.
 *
 * @param op the op discriminator
 * @param key the property name
 * @returns the sample value, with `or` between a union's branches, or undefined when the property
 *   is not in the schema
 */
export function propertyHint(op: string, key: string): string | undefined {
  const definition = opDefinitions().get(op);
  if (definition === undefined) return undefined;
  const properties = definition.properties;
  if (!isRecord(properties)) return undefined;
  const property = properties[key];
  if (property === undefined) return undefined;
  const alternatives = variants(property, 0);
  if (alternatives.length === 0) return undefined;
  return alternatives.join(" or ");
}

/** The required property names of an op, in schema order. */
export function requiredProperties(op: string): string[] {
  const definition = opDefinitions().get(op);
  if (definition === undefined) return [];
  const required = definition.required;
  return Array.isArray(required)
    ? required.filter((key): key is string => typeof key === "string")
    : [];
}

/** Samples a schema node, resolving local references. */
function sample(node: unknown, depth: number, includeAllOptional = false): unknown {
  if (depth > MAX_DEPTH) return null;
  if (!isRecord(node)) return null;
  if (typeof node.$ref === "string") {
    const resolved = resolve(node.$ref);
    return resolved === undefined ? null : sample(resolved, depth + 1, includeAllOptional);
  }

  if (typeof node.type === "string") {
    switch (node.type) {
      case "object":
        return sampleObject(node, depth, includeAllOptional);
      case "array":
        return sampleArray(node, depth);
      case "string":
        return sampleString(node);
      case "integer":
      case "number":
        return sampleNumber(node);
      case "boolean":
        return Array.isArray(node.enum) && typeof node.enum[0] === "boolean" ? node.enum[0] : false;
      default:
        return null;
    }
  }
  const alternatives = variants(node, depth);
  return alternatives.length === 0 ? null : JSON.parse(alternatives[0] ?? "null");
}

/**
 * Every branch of a `oneOf`/`anyOf` as a rendered value.
 *
 * @param node a schema node
 * @param depth the recursion depth
 * @returns one rendered value per branch (one for a plain schema)
 */
function variants(node: unknown, depth: number): string[] {
  if (!isRecord(node)) return [];
  for (const key of ["oneOf", "anyOf"] as const) {
    const branches = node[key];
    if (Array.isArray(branches)) {
      return branches
        .map((branch) => sample(branch, depth + 1))
        .filter((value) => value !== undefined)
        .map(compact);
    }
  }
  const value = sample(node, depth);
  return value === undefined ? [] : [compact(value)];
}

/** A sample object, following a local `$ref`. */
function sampleObject(node: JsonObject, depth: number, includeAllOptional: boolean): unknown {
  const properties = isRecord(node.properties) ? node.properties : {};
  const required = Array.isArray(node.required)
    ? node.required.filter((key): key is string => typeof key === "string")
    : [];
  let keys: string[];
  if (required.length > 0) keys = required;
  else if (includeAllOptional) keys = Object.keys(properties);
  else keys = Object.keys(properties).slice(0, 1);
  const out: JsonObject = {};
  for (const key of keys) {
    // `target` is only constrained to a non-empty string by the schema; the `fx:<id>/<param>`
    // format lives in 02 §3.7, so the sample spells it out instead of copying "text".
    out[key] =
      key === "target" ? "fx:fx_1/cutoffHz" : sampleProperty(key, properties[key], depth + 1);
  }
  return out;
}

/**
 * A property's sample, with readable, distinct ID placeholders.
 *
 * The patterns only pin the prefix, so the generic sampler would give `sectionId` and `newId` the
 * same `sec_a`. A copy or split must use a new ID, so the examples say so explicitly.
 */
function sampleProperty(key: string, node: unknown, depth: number): unknown {
  const placeholders: Record<string, string> = {
    trackId: "trk_1",
    sectionId: "sec_1",
    sectionIdA: "sec_1",
    sectionIdB: "sec_2",
    clipId: "clp_1",
    fxId: "fx_1",
    newId: newIdPlaceholder(node),
    // The fx instance's own ID, which the time-limited automation target must match.
    id: "fx_1",
  };
  if (key === "bpm") return 120;
  if (key === "tracks") return ["trk_1"];
  if (key === "startTick") return 0;
  if (key === "endTick") return 15360;
  if (key === "atTick") return 7680;
  if (key === "tick") return 0;
  const placeholder = placeholders[key];
  if (placeholder !== undefined) return placeholder;
  // A patch lists the fields the model may change (a mixer patch that only shows `name` would hide
  // `gainDb`, `mute` and friends), so its optional properties are all sampled.
  return sample(node, depth, key === "patch");
}

/** A distinct `newId` for a section or clip copy, matching the schema's prefix. */
function newIdPlaceholder(node: unknown): string {
  const value = sample(node, 0);
  const prefix = typeof value === "string" ? value.slice(0, 3) : "sec";
  return `${prefix}_2`;
}

/** A sample array with its minimum number of items (at least one when it has `items`). */
function sampleArray(node: JsonObject, depth: number): unknown {
  const items = node.items;
  if (items === undefined) return [];
  const count = typeof node.minItems === "number" ? node.minItems : 1;
  return Array.from({ length: count }, () => sample(items, depth + 1));
}

/** A sample string from the enum, the pattern's prefix or a name-based placeholder. */
function sampleString(node: JsonObject): string {
  const values = node.enum;
  if (Array.isArray(values) && typeof values[0] === "string") return values[0];
  if (typeof node.pattern === "string") return placeholderFor(node.pattern);
  return "text";
}

/** A pattern's shortest matching string, enough for the ID, hash and colour patterns here. */
function placeholderFor(pattern: string): string {
  const body = pattern.replace(/^\^/, "").replace(/\$$/, "");
  return expand(body);
}

/** Expands a small regular expression with literals, classes, quantifiers and `|` groups. */
function expand(pattern: string): string {
  let out = "";
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index];
    if (char === "\\") {
      out += pattern[index + 1] ?? "";
      index += 2;
      continue;
    }
    if (char === "[") {
      const end = pattern.indexOf("]", index + 1);
      if (end === -1) break;
      const charClass = pattern.slice(index + 1, end);
      const quantifier = /^\{(\d+)(?:,(\d*))?\}/.exec(pattern.slice(end + 1));
      const count = quantifier === null ? 1 : Number(quantifier[1]);
      const chosen =
        ["a", "0", "_"].find((candidate) => classContains(charClass, candidate)) ??
        charClass.replace(/\\/g, "")[0] ??
        "a";
      out += chosen.repeat(Math.max(1, count));
      index = end + 1 + (quantifier?.[0].length ?? 0);
      continue;
    }
    if (char === "(") {
      const end = matchingParen(pattern, index);
      if (end === -1) break;
      const first = pattern.slice(index + 1, end).split("|")[0] ?? "";
      out += expand(first.replace(/^\^/, "").replace(/\$$/, ""));
      index = end + 1;
      continue;
    }
    if (char === "{") {
      const end = pattern.indexOf("}", index);
      if (end !== -1) {
        index = end + 1;
        continue;
      }
    }
    out += char ?? "";
    index += 1;
  }
  return out;
}

/** True when a simple character class accepts one character. */
function classContains(charClass: string, candidate: string): boolean {
  const ranges = charClass.replace(/\\/g, "");
  if (ranges.includes(candidate)) return true;
  for (const match of ranges.matchAll(/([A-Za-z0-9])-([A-Za-z0-9])/g)) {
    const low = match[1];
    const high = match[2];
    if (low !== undefined && high !== undefined && candidate >= low && candidate <= high) {
      return true;
    }
  }
  return false;
}

/** The index of the `)` matching the `(` at `start`. */
function matchingParen(pattern: string, start: number): number {
  let depth = 0;
  for (let index = start; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** A sample number: neutral when the range contains 0, otherwise its lowest allowed value. */
function sampleNumber(node: JsonObject): number {
  const exclusive = node.exclusiveMinimum;
  const minimum = typeof exclusive === "number" ? exclusive + 1 : node.minimum;
  const maximum = node.maximum;
  if (typeof minimum === "number" && minimum > 0) return minimum;
  if (typeof maximum === "number" && maximum < 0) return maximum;
  return 0;
}

/** Resolves a local `$ref` through the generated `$defs`. */
function resolve(ref: string): unknown {
  if (!ref.startsWith("#/$defs/")) return undefined;
  return defs()[ref.slice("#/$defs/".length)];
}

/** Compact JSON for the prompt. */
function compact(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

/** A plain object, not an array or null. */
function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
