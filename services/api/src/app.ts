/**
 * The Fastify application (specs/05 §1–§2).
 *
 * `buildApp` wires the routes, the error envelope and the WebSocket gateway and
 * returns them; it never listens. `server.ts` and `orchestrator.ts` decide which
 * parts of the same codebase to run.
 */
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import type { NatsConnection } from "nats";
import type { Pool } from "pg";

import type { AuthInstance } from "./auth/auth.js";
import type { Session, SessionResolver } from "./auth/session.js";
import type { Config } from "./config.js";
import { ApiError } from "./errors.js";
import { registerAnalyses } from "./routes/analyses.js";
import { registerAssets } from "./routes/assets.js";
import { registerAuthRoutes } from "./routes/auth-routes.js";
import { registerJobs } from "./routes/jobs.js";
import { registerLibrary } from "./routes/library.js";
import { registerMeta } from "./routes/meta.js";
import type { ObjectStore } from "./s3/client.js";
import { WsGateway } from "./ws/gateway.js";

/** Everything the routes need; assembled once at boot. */
export interface AppContext {
  config: Config;
  pool: Pool;
  nc: NatsConnection;
  store: ObjectStore;
  auth: AuthInstance;
  /** The one session resolver; single-user returns the owner, multi-user Better Auth (ADR-0014). */
  sessions: SessionResolver;
  /** The owner account in single-user mode, absent in multi-user mode. */
  owner?: Session["user"];
}

export interface BuiltApp {
  app: FastifyInstance;
  gateway: WsGateway;
}

/** Builds the Fastify app (see module docstring). */
export async function buildApp(ctx: AppContext): Promise<BuiltApp> {
  const app = Fastify({
    logger: { level: ctx.config.nodeEnv === "test" ? "silent" : "info" },
    // The API never proxies audio; JSON bodies stay small (05 §11).
    bodyLimit: 1024 * 1024,
  });
  await app.register(websocket);

  // CORS (05 §8, finding 9): the web bundle is same-origin through the Vite
  // proxy, but the desktop webview and a direct dev origin are cross-origin.
  // Handled here rather than with a plugin, and only for configured origins.
  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (typeof origin === "string" && ctx.config.corsOrigins.includes(origin)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("access-control-allow-credentials", "true");
      reply.header("vary", "Origin");
      reply.header("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
      reply.header("access-control-allow-headers", "content-type,authorization");
      reply.header("access-control-max-age", "600");
    }
    if (request.method === "OPTIONS") {
      await reply.status(204).send();
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      reply.status(error.status).send(error.toBody());
      return;
    }
    if (isValidationError(error)) {
      reply.status(400).send(new ApiError("VALIDATION_FAILED", messageOf(error)).toBody());
      return;
    }
    request.log.error({ err: error }, "unhandled error");
    reply.status(500).send(new ApiError("INTERNAL", "internal error").toBody());
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send(new ApiError("NOT_FOUND", "no such route").toBody());
  });

  registerMeta(app, { config: ctx.config });
  registerAuthRoutes(app, {
    auth: ctx.auth,
    publicUrl: ctx.config.publicUrl,
    sessions: ctx.sessions,
    mode: ctx.config.authMode,
  });
  registerAssets(app, ctx);
  registerJobs(app, ctx);
  registerAnalyses(app, ctx);
  registerLibrary(app, ctx);

  const gateway = new WsGateway(ctx);
  app.get("/v1/ws", { websocket: true }, (socket, request) => {
    void gateway.handle(socket, request.headers);
  });

  return { app, gateway };
}

function isValidationError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "validation" in error;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "invalid request";
}
