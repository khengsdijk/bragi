/**
 * Session lookup for REST and the WebSocket handshake (specs/05 §8).
 *
 * Better Auth owns the cookie and the `session` table; this is only the small
 * adapter that turns a Node/undici header bag into a session, or `undefined`.
 */

import type { IncomingHttpHeaders } from "node:http";
import { fromNodeHeaders } from "better-auth/node";

import type { Config } from "../config.js";
import type { createAuth } from "./auth.js";
import type { OwnerUser } from "./single-user.js";

type AuthApi = ReturnType<typeof createAuth>["auth"]["api"];

/** The user + session pair Better Auth returns, or `undefined` when signed out. */
export type Session = {
  user: { id: string; email: string; name: string; plan?: string | null };
  session: { id: string; expiresAt: Date };
};

/** The synthetic session id single-user mode reports (ADR-0014). */
export const SINGLE_USER_SESSION_ID = "single-user";

/** Far enough out that the synthetic session never expires. */
const SINGLE_USER_EXPIRY = new Date("9999-12-31T00:00:00Z");

/** The one seam where a request's headers become a session (ADR-0014, 05 §8). */
export interface SessionResolver {
  resolve(headers: IncomingHttpHeaders): Promise<Session | undefined>;
}

export interface SessionResolverOptions {
  mode: Config["authMode"];
  /** Better Auth's API; only consulted in multi-user mode. */
  authApi: AuthApi;
  /** The owner account single-user mode signs in as (from `ensureOwner`). */
  owner?: OwnerUser;
}

/**
 * Builds the session resolver for the configured auth mode.
 *
 * In single-user mode every request resolves to the owner without a cookie; in
 * multi-user mode it delegates to Better Auth. Ownership checks never change,
 * because both modes produce a `user.id`.
 *
 * @throws Error when single-user mode has no owner (call `ensureOwner` first)
 */
export function createSessionResolver(opts: SessionResolverOptions): SessionResolver {
  if (opts.mode === "single-user") {
    const owner = opts.owner;
    if (owner === undefined) {
      throw new Error("single-user mode needs an owner: ensureOwner must run before the app boots");
    }
    const session: Session = {
      user: { id: owner.id, email: owner.email, name: owner.name },
      session: { id: SINGLE_USER_SESSION_ID, expiresAt: SINGLE_USER_EXPIRY },
    };
    return { resolve: async () => session };
  }
  return { resolve: (headers) => resolveSession(opts.authApi, headers) };
}

/** Resolves the session for a request's headers, or `undefined`. */
export async function resolveSession(
  api: AuthApi,
  headers: IncomingHttpHeaders,
): Promise<Session | undefined> {
  const session = await api.getSession({ headers: fromNodeHeaders(headers) });
  if (!session) return undefined;
  return session as unknown as Session;
}
