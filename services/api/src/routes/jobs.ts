/**
 * Direct job endpoints (specs/05 §2, §4.4).
 *
 * `POST /v1/jobs` is the path UI actions use when they skip the planner
 * ("Extend 16 bars"); the analysis DAG goes through `/v1/analyses` instead.
 * `DELETE` marks the job cancelled in Postgres *and* raises the NATS KV flag
 * workers poll between chunks.
 */
import type { FastifyInstance } from "fastify";
import { StringCodec } from "nats";

import type { AppContext } from "../app.js";
import { ApiError } from "../errors.js";
import { publishJobEvent } from "../jobs/publisher.js";
import { type JobPriority, submitJob } from "../jobs/service.js";
import { CANCEL_BUCKET } from "../nats/client.js";
import { pathParam, requireSession } from "./guards.js";

interface SubmitJobBody {
  capability: string;
  priority?: JobPriority;
  projectId?: string;
  assets?: Record<string, string>;
  blobs?: Record<string, string>;
  params?: Record<string, unknown>;
}

interface JobRow {
  id: string;
  capability: string;
  priority: string;
  status: string;
  outputs: unknown;
  error: unknown;
  created_at: Date;
  finished_at: Date | null;
}

const sc = StringCodec();

/** Registers `/v1/jobs*`. */
export function registerJobs(app: FastifyInstance, ctx: AppContext): void {
  app.post<{ Body: SubmitJobBody }>("/v1/jobs", async (request, reply) => {
    const session = await requireSession(ctx.auth, request);
    const body = request.body ?? { capability: "" };
    if (typeof body.capability !== "string" || body.capability === "") {
      throw new ApiError("VALIDATION_FAILED", "capability is required");
    }
    const priority: JobPriority = body.priority === "background" ? "background" : "interactive";
    const { job, status } = await submitJob(ctx, session.user.id, {
      capability: body.capability,
      priority,
      ...(body.projectId === undefined ? {} : { projectId: body.projectId }),
      assets: body.assets ?? {},
      ...(body.blobs === undefined ? {} : { blobs: body.blobs }),
      params: body.params ?? {},
    });
    reply.status(202);
    return { jobId: job.jobId, status, createdAt: job.createdAt };
  });

  app.get("/v1/jobs/:id", async (request) => {
    const session = await requireSession(ctx.auth, request);
    const id = pathParam(request, "id");
    const { rows } = await ctx.pool.query<JobRow>(
      `SELECT id, capability, priority, status, outputs, error, created_at, finished_at
       FROM jobs WHERE id = $1 AND user_id = $2`,
      [id, session.user.id],
    );
    const row = rows[0];
    if (!row) throw new ApiError("JOB_NOT_FOUND", "no such job");
    return {
      jobId: row.id,
      capability: row.capability,
      priority: row.priority,
      status: row.status,
      outputs: row.outputs,
      error: row.error,
      createdAt: row.created_at.toISOString(),
      finishedAt: row.finished_at?.toISOString() ?? null,
    };
  });

  app.delete("/v1/jobs/:id", async (request) => {
    const session = await requireSession(ctx.auth, request);
    const id = pathParam(request, "id");
    const { rowCount } = await ctx.pool.query(
      `UPDATE jobs SET status = 'cancelled', finished_at = now()
       WHERE id = $1 AND user_id = $2 AND status IN ('queued', 'running')`,
      [id, session.user.id],
    );
    if (rowCount === null || rowCount === 0) {
      throw new ApiError("JOB_NOT_FOUND", "no cancellable job with that id");
    }
    const kv = await ctx.nc.jetstream().views.kv(CANCEL_BUCKET);
    await kv.put(`cancel.${id}`, sc.encode("1"));
    await publishJobEvent(ctx.nc, {
      schemaVersion: 1,
      jobId: id,
      type: "failed",
      error: { code: "JOB_CANCELLED", message: "cancelled by the user", retryable: false },
    });
    return { jobId: id, status: "cancelled" };
  });
}
