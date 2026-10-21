/**
 * The `propose_edit_plan` tool schema the planner actually sends (06 §4).
 *
 * `PLAN_TOOL_SCHEMA` is the full generated `EditPlan` contract, and sending all of it costs more
 * prompt tokens than the whole song summary, the catalogue and the prompt together (WP-2.6 bench:
 * ~23k of ~27k). The envelope stays strict; the `ops` items are deliberately loose (`op` is an
 * enum, everything else is allowed) because the server validates every op against its own schema
 * before a variant is accepted (06 §5). The op keys the model needs are in the generated
 * `OP SHAPES` block (`opSchemas.ts`), not duplicated here.
 */
import { PLAN_TOOL_SCHEMA } from "@bragi/schemas";

import { plannerOpNames } from "./opSchemas.js";

/** A JSON object as the generated schema stores it. */
type JsonObject = Record<string, unknown>;

/** The slim schema, built once. */
let cached: JsonObject | undefined;

/** The tool input schema: the `EditPlan` envelope with loose steps. */
export function plannerToolSchema(): JsonObject {
  if (cached !== undefined) return cached;
  const schema = structuredClone(PLAN_TOOL_SCHEMA);
  const defs = schema.$defs;
  if (!isRecord(defs)) throw new Error("PLAN_TOOL_SCHEMA has no $defs");
  defs.PlanStep = looseSteps();
  // `notices` is filled from the policy pre-pass, not by the model.
  if (isRecord(schema.properties)) delete schema.properties.notices;
  schema.$defs = prunedDefs(defs, refsIn(schema));
  stripSchemaNoise(schema);
  cached = schema;
  return cached;
}

/**
 * The four step kinds.
 *
 * `ops` is the only one whose contents the model writes in full (the op shapes block samples
 * them); a generate step's params are the capability's schema and a placement's region is a
 * `Region`, both of which would cost more prompt than they save, so their keys are required but
 * untyped here and validated server-side with a precise error (06 §5).
 */
function looseSteps(): JsonObject {
  return {
    oneOf: [
      looseOpsStep(),
      looseStep("generate", ["id", "capability", "params", "context"]),
      looseStep("apply_generated", ["from", "placement"]),
      looseStep("smooth", ["region", "tools"]),
    ],
  };
}

/** One step of a given kind: `kind` plus the keys that kind must carry. */
function looseStep(kind: string, keys: readonly string[]): JsonObject {
  return {
    type: "object",
    additionalProperties: true,
    required: ["kind", ...keys],
    properties: {
      kind: { type: "string", enum: [kind] },
    },
  };
}

/**
 * One `{ kind: "ops", ops: [...] }` step.
 *
 * `op` is enumerated so a typo is caught by the provider's schema check; the op's other
 * properties are validated server-side, op by op, with the precise error the repair round reads.
 */
function looseOpsStep(): JsonObject {
  return {
    type: "object",
    additionalProperties: false,
    required: ["kind", "ops"],
    properties: {
      kind: { type: "string", enum: ["ops"] },
      ops: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["op"],
          additionalProperties: true,
          properties: {
            op: { type: "string", enum: plannerOpNames() },
          },
        },
      },
    },
  };
}

/** `$defs` restricted to the entries reachable from the schema body. */
function prunedDefs(defs: JsonObject, roots: ReadonlySet<string>): JsonObject {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const name = queue.pop();
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);
    for (const ref of refsIn(defs[name])) if (!seen.has(ref)) queue.push(ref);
  }
  return Object.fromEntries(
    Object.keys(defs)
      .filter((name) => seen.has(name))
      .sort()
      .map((name) => [name, defs[name]]),
  );
}

/**
 * Drops schema metadata no provider or model reads (`$schema`, `title`).
 *
 * Property *names* are kept: only the definitions inside a `properties` object are walked, so a
 * field called `title` would survive.
 */
function stripSchemaNoise(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) stripSchemaNoise(item);
    return;
  }
  if (!isRecord(node)) return;
  delete node.$schema;
  delete node.title;
  for (const [key, value] of Object.entries(node)) {
    if (key === "properties" && isRecord(value)) {
      for (const definition of Object.values(value)) stripSchemaNoise(definition);
    } else {
      stripSchemaNoise(value);
    }
  }
}

/** Every `#/$defs/…` reference in a schema node, excluding its own `$defs`. */
function refsIn(node: unknown): Set<string> {
  const found = new Set<string>();
  walk(node, found);
  return found;
}

/** Walks a schema node, collecting the local definition names it references. */
function walk(node: unknown, found: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, found);
    return;
  }
  if (!isRecord(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === "$defs") continue;
    if (key === "$ref" && typeof value === "string" && value.startsWith("#/$defs/")) {
      found.add(value.slice("#/$defs/".length));
    } else {
      walk(value, found);
    }
  }
}

/** A plain object, not an array or null. */
function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
