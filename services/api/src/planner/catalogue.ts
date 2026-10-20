/**
 * The planner's capability catalogue (06 §2, §4).
 *
 * Built from the generated DSP catalogues and the generated planner tool schema, so it cannot
 * describe an fx parameter, macro or op that the model does not have. It carries IDs and numbers
 * only: no prose, no labels, no help text. Generation capabilities are an empty registry in v1
 * (WP-2.7 fills it).
 */
import { FX_CATALOG, MACROS, PLAN_TOOL_SCHEMA } from "@bragi/schemas";

/** One parameter: numeric ranges where the catalogue has them. */
export interface CatalogueParam {
  min?: number;
  max?: number;
  default?: number;
  type?: string;
}

/** One op and the IDs it needs at the top level or in a nested scope. */
export interface CatalogueOp {
  op: string;
  ids: string[];
}

/** The catalogue as the model sees it, serialised compactly into the user message. */
export interface CapabilityCatalogue {
  ops: CatalogueOp[];
  fx: Record<string, Record<string, CatalogueParam>>;
  macros: Record<string, { min: number; max: number }>;
  generation: unknown[];
}

/** A JSON object as the generated tool schema stores it. */
type JsonObject = Record<string, unknown>;

/**
 * Builds the catalogue from the generated sources.
 *
 * @returns the catalogue, deterministic for a given schema and DSP catalogue
 */
export function buildCatalogue(): CapabilityCatalogue {
  return {
    ops: opCatalogue(),
    fx: fxCatalogue(),
    macros: Object.fromEntries(
      MACROS.macros.map((macro) => [macro.id, { min: macro.range[0], max: macro.range[1] }]),
    ),
    generation: [],
  };
}

/** The catalogue as one compact JSON line for the prompt. */
export function catalogueText(catalogue: CapabilityCatalogue = buildCatalogue()): string {
  return JSON.stringify(catalogue);
}

/** Every op name and the required `…Id` properties it names, from the generated `Op` schema. */
function opCatalogue(): CatalogueOp[] {
  const defs = PLAN_TOOL_SCHEMA.$defs;
  if (!isRecord(defs)) throw new Error("PLAN_TOOL_SCHEMA has no $defs");
  const opDef = defs.Op;
  if (!isRecord(opDef) || !Array.isArray(opDef.oneOf)) {
    throw new Error("PLAN_TOOL_SCHEMA.$defs.Op is not a oneOf union");
  }

  const out: CatalogueOp[] = [];
  for (const branch of opDef.oneOf) {
    if (!isRecord(branch) || typeof branch.$ref !== "string") continue;
    const name = branch.$ref.slice("#/$defs/".length);
    const definition = defs[name];
    if (!isRecord(definition)) continue;
    const op = discriminator(definition, defs);
    if (op === undefined) continue;
    out.push({ op, ids: requiredIds(definition, defs) });
  }
  return out;
}

/** The single-value `op` discriminator of one op definition. */
function discriminator(definition: JsonObject, defs: Record<string, unknown>): string | undefined {
  const properties = definition.properties;
  if (!isRecord(properties)) return undefined;
  const value = properties.op;
  if (!isRecord(value)) return undefined;
  if (typeof value.$ref === "string") {
    const target = defs[value.$ref.slice("#/$defs/".length)];
    if (isRecord(target) && Array.isArray(target.enum) && typeof target.enum[0] === "string") {
      return target.enum[0];
    }
  }
  if (Array.isArray(value.enum) && typeof value.enum[0] === "string") return value.enum[0];
  return undefined;
}

/** Every required property ending in `Id`, including nested scopes and union branches. */
function requiredIds(definition: JsonObject, defs: Record<string, unknown>): string[] {
  const found = new Set<string>();
  walkIds(definition, defs, found, new Set());
  return [...found].sort();
}

/** Walks a schema node, following local `$ref`s, collecting required `…Id` property names. */
function walkIds(
  node: unknown,
  defs: Record<string, unknown>,
  found: Set<string>,
  visited: Set<string>,
): void {
  if (Array.isArray(node)) {
    for (const item of node) walkIds(item, defs, found, visited);
    return;
  }
  if (!isRecord(node)) return;

  if (typeof node.$ref === "string" && node.$ref.startsWith("#/$defs/")) {
    const name = node.$ref.slice("#/$defs/".length);
    if (!visited.has(name)) {
      visited.add(name);
      walkIds(defs[name], defs, found, visited);
    }
    return;
  }

  const properties = node.properties;
  if (isRecord(properties)) {
    const required = Array.isArray(node.required)
      ? node.required.filter((key): key is string => typeof key === "string")
      : [];
    for (const [key, value] of Object.entries(properties)) {
      if (key.endsWith("Id") && required.includes(key)) found.add(key);
      // Only `scope` nests the IDs an op needs (fx/clip/master); patch payloads may mention IDs
      // incidentally and are not part of the op's addressing.
      if (key === "scope") walkIds(value, defs, found, visited);
    }
  }
  for (const key of ["oneOf", "anyOf", "allOf", "items"] as const) {
    if (node[key] !== undefined) walkIds(node[key], defs, found, visited);
  }
}

/** Numeric ranges per fx type and parameter, from `fx_catalog.json`. */
function fxCatalogue(): Record<string, Record<string, CatalogueParam>> {
  const out: Record<string, Record<string, CatalogueParam>> = {};
  for (const [type, definition] of Object.entries(FX_CATALOG.fx)) {
    const params: Record<string, CatalogueParam> = {};
    for (const [name, spec] of Object.entries(definition.params)) {
      params[name] =
        "min" in spec
          ? { min: spec.min, max: spec.max, default: spec.default }
          : { type: spec.type };
    }
    out[type] = params;
  }
  return out;
}

/** A plain object, not an array or null. */
function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
