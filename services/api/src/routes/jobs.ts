/**
 * Direct job endpoints (specs/05 §2, §4.4, §9).
 *
 * `POST /v1/jobs` is the path UI actions use when they skip the planner
 * ("Extend 16 bars"); the analysis DAG goes through `/v1/analyses` instead. The
 * submit path is where the capability's params schema, the credit allowance and
 * the GPU budget meet: a bad param is a 400 naming the field, an unaffordable job
 * is a 402, and generation past the daily GPU cap is a 503 (`GENERATION_BUSY`) for
 * interactive work or a `paused` job row for background work.
 *
 * `DELETE` marks the job cancelled in Postgres *and* raises the NATS KV flag
 * workers poll between chunks.
 */
import type { FastifyInstance } from "fastify";
import { StringCodec } from "nats";

import type { AppContext } from "../app.js";
import { ApiError } from "../errors.js";
import { isAssetHash } from "../ids.js";
import { budgetExceeded, isGpuCapability } from "../jobs/budget.js";
import { validateCapabilityParams } from "../jobs/capabilities.js";
import {
  creditCharge,
  creditsConfig,
  creditsUsedToday,
  dailyCreditAllowance,
  fitsAllowance,
} from "../jobs/credits.js";
import { publishJobEvent } from "../jobs/publisher.js";
import { type JobPriority, type LedgerEntry, submitJob } from "../jobs/service.js";
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
    const session = await requireSession(ctx.sessions, request);
    const body = request.body ?? { capability: "" };
    if (typeof body.capability !== "string" || body.capability === "") {
      throw new ApiError("VALIDATION_FAILED", "capability is required");
    }
    const priority: JobPriority = body.priority === "background" ? "background" : "interactive";
    const params = body.params ?? {};
    validateCapabilityParams(body.capability, params);
    assertGenerationInputs(body);
    await assertOwnsInputs(ctx, session.user.id, body);

    const credits = creditsConfig(ctx.config.creditsConfig);
    const charge = creditCharge(body.capability, params, credits);
    if (charge.credits > 0) {
      const allowance = dailyCreditAllowance(ctx.config, credits);
      const used = await creditsUsedToday(ctx.pool, session.user.id);
      if (!fitsAllowance(used, allowance, charge.credits)) {
        throw new ApiError("INSUFFICIENT_CREDITS", "not enough credits for this job today", {
          required: charge.credits,
          used,
          allowance: allowance ?? null,
        });
      }
    }

    const enqueue = await mayEnqueue(ctx, body.capability, priority);
    const ledger: LedgerEntry | undefined =
      enqueue && charge.credits > 0
        ? {
            credits: charge.credits,
            capability: body.capability,
            ...(charge.tier === undefined ? {} : { tier: charge.tier }),
            reason: `${body.capability} ${priority}`,
          }
        : undefined;

    const { job, status } = await submitJob(
      ctx,
      session.user.id,
      {
        capability: body.capability,
        priority,
        ...(body.projectId === undefined ? {} : { projectId: body.projectId }),
        assets: body.assets ?? {},
        ...(body.blobs === undefined ? {} : { blobs: body.blobs }),
        params,
      },
      { enqueue, ...(ledger === undefined ? {} : { ledger }) },
    );
    reply.status(202);
    return {
      jobId: job.jobId,
      status,
      createdAt: job.createdAt,
      estimatedCredits: charge.credits,
    };
  });

  app.get("/v1/jobs/:id", async (request) => {
    const session = await requireSession(ctx.sessions, request);
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
    const session = await requireSession(ctx.sessions, request);
    const id = pathParam(request, "id");
    const { rowCount } = await ctx.pool.query(
      `UPDATE jobs SET status = 'cancelled', finished_at = now()
       WHERE id = $1 AND user_id = $2 AND status IN ('queued', 'running', 'paused')`,
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

/**
 * `generate.extend` cannot run without the rendered context (09 §2.1, §4.2).
 *
 * The params schema cannot express this: the audio is a job input, not a param
 * (`inputs.assets.context`), so it is checked here where the whole request is in
 * hand.
 */
function assertGenerationInputs(body: SubmitJobBody): void {
  if (body.capability !== "generate.extend") return;
  const context = body.assets?.context;
  if (typeof context !== "string" || !isAssetHash(context)) {
    throw new ApiError(
      "VALIDATION_FAILED",
      "assets.context must be the sha256 hash of the rendered context audio",
      { capability: body.capability },
    );
  }
}

/**
 * A generation job may only read audio the user owns.
 *
 * The worker downloads inputs by hash without an ownership check, so the submit is
 * the gate: otherwise a guessed hash would let somebody generate from another
 * user's audio and then own the output (05 §6, §12).
 */
async function assertOwnsInputs(
  ctx: AppContext,
  userId: string,
  body: SubmitJobBody,
): Promise<void> {
  if (!isGpuCapability(body.capability)) return;
  for (const hash of Object.values(body.assets ?? {})) {
    const { rowCount } = await ctx.pool.query(
      "SELECT 1 FROM user_assets WHERE user_id = $1 AND hash = $2",
      [userId, hash],
    );
    if (rowCount === null || rowCount === 0) throw new ApiError("NOT_FOUND", "asset not found");
  }
}

/**
 * Applies the daily GPU-seconds budget (05 §9).
 *
 * @returns whether the job may be enqueued; interactive generation past the cap
 *   throws `GENERATION_BUSY` instead of pausing, because the user is waiting
 */
async function mayEnqueue(
  ctx: AppContext,
  capability: string,
  priority: JobPriority,
): Promise<boolean> {
  if (!isGpuCapability(capability)) return true;
  if (!(await budgetExceeded(ctx.pool, ctx.config))) return true;
  if (priority === "interactive") {
    throw new ApiError(
      "GENERATION_BUSY",
      "the daily GPU budget is spent; interactive generation resumes tomorrow",
    );
  }
  return false;
}
