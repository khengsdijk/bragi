/**
 * Per-capability params validation at submit (specs/05 §2, §4.2).
 *
 * The worker validates its params again before running (05 §4.3), but the API must
 * reject a bad request while it still has the user in front of it: a 400 naming
 * the field beats a job that fails a second later. The registry maps a capability
 * to the generated validator from `packages/schemas`; a capability without an
 * entry keeps the pre-WP-2.7 behaviour (the worker is the schema authority).
 */
import { validateGenerateExtendParams } from "@bragi/schemas";

import { ApiError } from "../errors.js";

/** The subset of Ajv's `ErrorObject` a user-facing message needs. */
interface ValidationIssue {
  readonly instancePath?: string;
  readonly keyword?: string;
  readonly message?: string;
  readonly params?: {
    readonly missingProperty?: string;
    readonly additionalProperty?: string;
  };
}

/** A generated Ajv validator: the call narrows, `errors` explains a failure. */
type ParamsValidator = ((value: unknown) => boolean) & {
  readonly errors?: readonly ValidationIssue[] | null;
};

/** Capability → params validator. Only the implemented capabilities appear. */
export const PARAMS_VALIDATORS: Readonly<Record<string, ParamsValidator>> = {
  "generate.extend": validateGenerateExtendParams,
};

/** `params.a.b`, skipping empty segments. */
function field(...parts: readonly (string | undefined)[]): string {
  return parts.filter((part) => part !== undefined && part !== "").join(".");
}

/** One Ajv issue as a sentence a client can show. */
function describe(issue: ValidationIssue): string {
  const path = issue.instancePath?.replace(/^\//, "").replaceAll("/", ".");
  if (issue.keyword === "required") {
    return `${field("params", path, issue.params?.missingProperty)} is required`;
  }
  if (issue.keyword === "additionalProperties") {
    return `${field("params", path, issue.params?.additionalProperty)} is not a parameter of this capability`;
  }
  return `${field("params", path) || "params"}: ${issue.message ?? "is invalid"}`;
}

/**
 * Validates one job's params against its capability's schema.
 *
 * @throws ApiError `VALIDATION_FAILED` naming the first offending field
 */
export function validateCapabilityParams(
  capability: string,
  params: Record<string, unknown>,
): void {
  const validator = PARAMS_VALIDATORS[capability];
  if (validator === undefined || validator(params)) return;
  const issue = validator.errors?.[0];
  throw new ApiError(
    "VALIDATION_FAILED",
    issue === undefined ? "params do not match the capability schema" : describe(issue),
    { capability },
  );
}
