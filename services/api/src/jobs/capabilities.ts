/**
 * Per-capability params validation at submit (specs/05 §2, §4.2).
 *
 * The worker validates its params again before running (05 §4.3), but the API must
 * reject a bad request while it still has the user in front of it: a 400 naming
 * the field beats a job that fails a second later. The registry maps a capability
 * to the generated validator from `packages/schemas`; a capability without an
 * entry keeps the pre-WP-2.7 behaviour (the worker is the schema authority).
 *
 * It also says which input assets a capability cannot run without. The audio is a
 * job input, not a param (09 §2.1), so the params schema cannot express it: a
 * `generate.extend` needs `context`, an inpaint or transition needs both sides.
 */
import {
  validateGenerateExtendParams,
  validateGenerateInpaintParams,
  validateGenerateTransitionParams,
} from "@bragi/schemas";

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
  "generate.inpaint": validateGenerateInpaintParams,
  "generate.transition": validateGenerateTransitionParams,
};

/**
 * Capability → the input assets it cannot run without (09 §2.1, §4.2–4.4).
 *
 * The values are the keys of `inputs.assets`; the audio itself is content-addressed
 * and streamed like any other input, so the schema never sees it.
 */
export const CAPABILITY_INPUT_ASSETS: Readonly<Record<string, readonly string[]>> = {
  "generate.extend": ["context"],
  "generate.inpaint": ["before", "after"],
  "generate.transition": ["before", "after"],
};

/** The input asset keys a capability requires, or an empty list for the others. */
export function requiredInputAssets(capability: string): readonly string[] {
  return CAPABILITY_INPUT_ASSETS[capability] ?? [];
}

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
 * The first reason `params` do not match the capability's schema.
 *
 * @param capability the job's capability
 * @param params its params
 * @returns `undefined` when the params validate, or when the capability has no schema
 */
export function capabilityParamsError(
  capability: string,
  params: Record<string, unknown>,
): string | undefined {
  const validator = PARAMS_VALIDATORS[capability];
  if (validator === undefined || validator(params)) return undefined;
  const issue = validator.errors?.[0];
  return issue === undefined ? "params do not match the capability schema" : describe(issue);
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
  const message = capabilityParamsError(capability, params);
  if (message === undefined) return;
  throw new ApiError("VALIDATION_FAILED", message, { capability });
}
