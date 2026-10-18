/**
 * Mounts Better Auth under `/v1/auth/*` (specs/05 §2, §8).
 *
 * Fastify hands us a Node request; Better Auth speaks the Fetch API. The
 * adapter below is the documented bridge: copy the headers, run the handler,
 * copy the response back — including every `Set-Cookie` separately, which a
 * naive join would corrupt.
 */
import type { FastifyInstance } from "fastify";

import type { AuthInstance } from "../auth/auth.js";

export interface AuthRoutesDeps {
  auth: AuthInstance;
  publicUrl: string;
}

/** Registers the Better Auth catch-all. */
export function registerAuthRoutes(app: FastifyInstance, deps: AuthRoutesDeps): void {
  app.route({
    method: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    url: "/v1/auth/*",
    handler: async (request, reply) => {
      const url = new URL(request.raw.url ?? "/", deps.publicUrl);
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) for (const item of value) headers.append(key, item);
        else headers.append(key, value);
      }

      const init: RequestInit = { method: request.method, headers, redirect: "manual" };
      if (request.method !== "GET" && request.method !== "HEAD" && request.body !== undefined) {
        init.body = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
      }

      const response = await deps.auth.handler(new Request(url, init));
      reply.status(response.status);
      response.headers.forEach((value, key) => {
        if (key === "set-cookie" || key === "content-length") return;
        reply.header(key, value);
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 0) reply.header("set-cookie", cookies);
      const text = await response.text();
      return reply.send(text === "" ? null : text);
    },
  });
}
