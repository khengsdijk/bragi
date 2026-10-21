/**
 * Generation-only endpoints (specs/05 §2, specs/09 §5).
 *
 * `POST /v1/generations/warmup` is the canvas-open ping: it asks the generation
 * worker to load the model so the user's first extend does not pay the cold start.
 * It is cheap, idempotent, and answers `disabled` when the environment has no
 * generation worker. Submission itself stays on `POST /v1/jobs`.
 */
import type { FastifyInstance } from "fastify";

import type { AppContext } from "../app.js";
import { WarmupService } from "../jobs/warmup.js";
import { requireSession } from "./guards.js";

/** Registers `/v1/generations/*`. */
export function registerGenerations(app: FastifyInstance, ctx: AppContext): void {
  // One service per API process: its in-flight promise dedupes concurrent pings.
  const warmup = new WarmupService(ctx);

  app.post("/v1/generations/warmup", async (request, reply) => {
    const session = await requireSession(ctx.sessions, request);
    const status = await warmup.request(session.user.id);
    reply.status(202);
    return { status };
  });
}
