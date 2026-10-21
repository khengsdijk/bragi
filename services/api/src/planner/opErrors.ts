/**
 * Precise op validation for the repair round (06 §5).
 *
 * `EditPlan`'s schema is an `Op` union: validating the whole plan reports every branch's missing
 * property at once, which is what the model saw as "must have required property 'sourceId'", "'stage'",
 * "'blob'" and an `op` enum mismatch when the real mistake was one wrong property. Here each op is
 * checked once against the schema its `op` discriminator selects, and the error names the op, the
 * offending property and the shape that op needs.
 */
import { OP_VALIDATORS } from "@bragi/schemas";

import { opDefinitions, plannerOpNames, propertyHint, requiredProperties } from "./opSchemas.js";

/** The Ajv error fields this module reads. */
interface SchemaError {
  instancePath?: string;
  keyword?: string;
  params?: Record<string, unknown>;
  message?: string;
}

/** What the op pass found. */
export interface OpShapeResult {
  /** One short line per problem, in variant/op order. */
  errors: string[];
  /** The failed op and step paths, so plan-level union noise can be filtered out. */
  paths: Set<string>;
}

/**
 * Validates every `ops` step's ops, one schema per op.
 *
 * @param raw the parsed plan (untrusted)
 * @returns the human-readable errors and the failing op paths
 */
export function opShapeErrors(raw: unknown): OpShapeResult {
  const errors: string[] = [];
  const paths = new Set<string>();
  if (!isRecord(raw) || !Array.isArray(raw.variants)) return { errors, paths };

  raw.variants.forEach((variant, variantIndex) => {
    if (!isRecord(variant) || !Array.isArray(variant.steps)) return;
    variant.steps.forEach((step, stepIndex) => {
      if (!isRecord(step) || step.kind !== "ops" || !Array.isArray(step.ops)) return;
      const stepPath = `/variants/${variantIndex}/steps/${stepIndex}`;
      step.ops.forEach((op, opIndex) => {
        const found = errorsForOp(op, `variant ${variantIndex + 1}, op ${opIndex + 1}`);
        if (found.length === 0) return;
        // The plan-level union reports the whole step as a failed PlanStep branch (missing `id`,
        // `capability`, …) because one op did not match; those lines are noise next to the op's
        // own error, so the step path is filtered as well as the op path.
        paths.add(stepPath);
        paths.add(`${stepPath}/ops/${opIndex}`);
        errors.push(...found);
      });
    });
  });
  return { errors, paths };
}

/** The errors for one op, or none when it is valid. */
function errorsForOp(op: unknown, where: string): string[] {
  if (!isRecord(op)) return [`${where}: expected an object with an "op" property`];
  const name = op.op;
  const usable = plannerOpNames();
  if (typeof name !== "string" || name === "") {
    return [`${where}: missing "op"; use one of: ${usable.join(", ")}`];
  }
  if (!usable.includes(name)) {
    const known = opDefinitions().has(name)
      ? `"${name}" is not an op the planner may use; use one of`
      : `unknown op "${name}"; known ops are`;
    return [`${where}: ${known} ${usable.join(", ")}`];
  }
  const validate = OP_VALIDATORS[name];
  if (validate === undefined) return [`${where}: unknown op "${name}"`];
  if (validate(op)) return [];

  // The op's own schema can still contain a union (a scope, a patch): its generic oneOf line is
  // noise next to the branch's concrete missing property.
  const all = (validate.errors ?? []) as SchemaError[];
  const specific = all.filter((error) => !["oneOf", "anyOf", "not"].includes(error.keyword ?? ""));
  return (specific.length > 0 ? specific : all)
    .slice(0, 4)
    .map((error) => `${where} (${name}): ${describe(error, name)}`);
}

/** One Ajv error as a short line that names the property and, when useful, the shape. */
function describe(error: SchemaError, op: string): string {
  const path = dotted(error.instancePath ?? "");
  switch (error.keyword) {
    case "required": {
      const missing = stringParam(error, "missingProperty");
      const name = path === "" ? (missing ?? "property") : `${path}.${missing ?? "property"}`;
      const hint = path === "" && missing !== undefined ? propertyHint(op, missing) : undefined;
      return `missing "${name}"${
        hint === undefined ? "" : `; ${op} needs ${JSON.stringify(missing ?? "")}: ${short(hint)}`
      }`;
    }
    case "additionalProperties": {
      const extra = stringParam(error, "additionalProperty") ?? "property";
      const name = path === "" ? `"${extra}"` : `"${path}.${extra}"`;
      return `unknown property ${name}; ${opNeeds(op)}`;
    }
    case "enum": {
      const allowed = Array.isArray(error.params?.allowedValues)
        ? error.params.allowedValues.map((value) => JSON.stringify(value)).join(", ")
        : "";
      return `${quote(path)} must be one of ${allowed}`;
    }
    case "type":
      return `${quote(path)} must be ${String(error.params?.type ?? "the right type")}`;
    case "minimum":
    case "exclusiveMinimum":
    case "maximum":
    case "minLength":
    case "maxLength":
    case "pattern":
      return `${quote(path)} ${error.message ?? "is out of range"}`;
    default:
      return `${quote(path === "" ? "op" : path)} ${error.message ?? "is invalid"}`;
  }
}

/** The properties an op needs, with a sample for each required one. */
function opNeeds(op: string): string {
  const required = requiredProperties(op).filter((key) => key !== "op");
  if (required.length === 0) return "check its properties";
  const parts = required.map((key) => {
    const hint = propertyHint(op, key);
    return hint === undefined ? `"${key}"` : `"${key}" (${short(hint)})`;
  });
  return `${op} needs ${parts.join(" and ")}`;
}

/** Caps a sample so one line stays readable in the repair prompt. */
function short(text: string): string {
  return text.length <= 110 ? text : `${text.slice(0, 107)}…`;
}

/** A string param from an Ajv error. */
function stringParam(error: SchemaError, key: string): string | undefined {
  const value = error.params?.[key];
  return typeof value === "string" ? value : undefined;
}

/** `/scope/trackId` → `scope.trackId`; the op root becomes an empty string. */
function dotted(instancePath: string): string {
  return instancePath.replace(/^\//, "").replaceAll("/", ".");
}

/** A path in quotes, or "the op" at the root. */
function quote(path: string): string {
  return path === "" ? "the op" : `"${path}"`;
}

/** A plain object, not an array or null. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
