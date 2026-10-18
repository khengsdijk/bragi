/**
 * Session lookup for REST and the WebSocket handshake (specs/05 §8).
 *
 * Better Auth owns the cookie and the `session` table; this is only the small
 * adapter that turns a Node/undici header bag into a session, or `undefined`.
 */

import type { IncomingHttpHeaders } from "node:http";
import { fromNodeHeaders } from "better-auth/node";

import type { createAuth } from "./auth.js";

type AuthApi = ReturnType<typeof createAuth>["auth"]["api"];

/** The user + session pair Better Auth returns, or `undefined` when signed out. */
export type Session = {
  user: { id: string; email: string; name: string; plan?: string | null };
  session: { id: string; expiresAt: Date };
};

/** Resolves the session for a request's headers, or `undefined`. */
export async function resolveSession(
  api: AuthApi,
  headers: IncomingHttpHeaders,
): Promise<Session | undefined> {
  const session = await api.getSession({ headers: fromNodeHeaders(headers) });
  if (!session) return undefined;
  return session as unknown as Session;
}
