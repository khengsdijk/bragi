/** Shared route helpers. */
import type { FastifyRequest } from "fastify";

import type { Session, SessionResolver } from "../auth/session.js";
import { ApiError } from "../errors.js";

/** The signed-in user, or `401 AUTH_REQUIRED` (05 §2). */
export async function requireSession(
  sessions: SessionResolver,
  request: FastifyRequest,
): Promise<Session> {
  const session = await sessions.resolve(request.headers);
  if (!session) throw new ApiError("AUTH_REQUIRED", "sign in to continue");
  return session;
}

/** A single string path parameter. */
export function pathParam(request: FastifyRequest, name: string): string {
  const value = (request.params as Record<string, unknown>)[name];
  if (typeof value !== "string" || value === "") {
    throw new ApiError("VALIDATION_FAILED", `missing path parameter ${name}`);
  }
  return value;
}
