/**
 * The API error envelope (specs/05-backend-and-jobs.md §2).
 *
 * `code` is always one of `packages/schemas/api/errors.json`; the HTTP status is
 * that registry's, so a client can switch on the code without a lookup table of
 * its own.
 */
import type { ErrorCode } from "@bragi/schemas";

/** HTTP status per error code, from `packages/schemas/api/errors.json`. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  AUTH_REQUIRED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 400,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  QUOTA_EXCEEDED: 429,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  ASSET_TOO_LONG: 422,
  ASSET_CORRUPT: 422,
  JOB_NOT_FOUND: 404,
  JOB_CANCELLED: 409,
  MODEL_ERROR: 502,
  UPSTREAM_UNAVAILABLE: 503,
  BUDGET_EXCEEDED: 503,
  COMMIT_PARENT_MISSING: 409,
  INTERNAL: 500,
};

/** An error that is safe to serialise to the client verbatim. */
export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    override readonly message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }

  /** The 05 §2 response body. */
  toBody(): { error: { code: ErrorCode; message: string; details?: Record<string, unknown> } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

/** True when `value` is a known error code. */
export function isErrorCode(value: string): value is ErrorCode {
  return Object.hasOwn(ERROR_STATUS, value);
}
