/**
 * Job submission (specs/05 §2, §4.2, §9).
 *
 * The traceparent of the publishing span is written into the envelope, which is
 * what links the API span to the worker span in one trace (05 §11).
 */
import type { JobRequest } from "@bragi/schemas";
import { SpanKind } from "@opentelemetry/api";
import type { NatsConnection } from "nats";
import type { Pool } from "pg";

import { hashBytes, newJobId } from "../ids.js";
import { getTracer, spanContextToTraceparent } from "../telemetry.js";
import { publishJobRequest } from "./publisher.js";

export type JobPriority = "interactive" | "background";

export interface DirectJobInput {
  capability: string;
  priority: JobPriority;
  projectId?: string;
  assets: Record<string, string>;
  blobs?: Record<string, string>;
  params: Record<string, unknown>;
  attempt?: number;
  deadlineSec?: number;
}

export interface SubmittedJob {
  job: JobRequest;
  status: "queued";
}

/** What job submission needs: the database and the bus. */
export interface JobDeps {
  pool: Pool;
  nc: NatsConnection;
}

/**
 * Deterministic cache key: `hash(capability, inputs, stageVersion)` (05 §4.2).
 */
export function idempotencyKey(input: DirectJobInput): string {
  const payload = {
    capability: input.capability,
    assets: sortRecord(input.assets),
    blobs: sortRecord(input.blobs ?? {}),
    params: sortRecord(input.params),
  };
  return hashBytes(new TextEncoder().encode(JSON.stringify(payload)));
}

function sortRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** Inserts a job row, publishes the request, and returns the envelope. */
export async function submitJob(
  deps: JobDeps,
  userId: string,
  input: DirectJobInput,
): Promise<SubmittedJob> {
  const createdAt = new Date();
  const jobId = newJobId();
  const key = idempotencyKey(input);
  const deadline = new Date(createdAt.getTime() + (input.deadlineSec ?? 60 * 60) * 1000);

  return getTracer().startActiveSpan(
    "jobs.publish",
    {
      kind: SpanKind.PRODUCER,
      attributes: {
        "messaging.system": "nats",
        "messaging.destination.name": `jobs.${input.capability}.${input.priority}`,
        "bragi.job.id": jobId,
        "bragi.job.capability": input.capability,
      },
    },
    async (span) => {
      try {
        const job: JobRequest = {
          schemaVersion: 1,
          jobId,
          capability: input.capability,
          priority: input.priority,
          userId,
          ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
          inputs: {
            assets: input.assets,
            ...(input.blobs === undefined ? {} : { blobs: input.blobs }),
            params: input.params,
          },
          idempotencyKey: key,
          attempt: input.attempt ?? 0,
          deadline: deadline.toISOString(),
          traceparent: spanContextToTraceparent(span.spanContext()),
          createdAt: createdAt.toISOString(),
        };
        await deps.pool.query(
          `INSERT INTO jobs (id, user_id, project_id, capability, priority, status, params, idempotency_key, input_hash, traceparent)
           VALUES ($1, $2, $3, $4, $5, 'queued', $6, $7, $8, $9)`,
          [
            jobId,
            userId,
            input.projectId ?? null,
            input.capability,
            input.priority,
            JSON.stringify(input.params),
            key,
            JSON.stringify(input.assets),
            job.traceparent,
          ],
        );
        await publishJobRequest(deps.nc, job);
        return { job, status: "queued" as const };
      } finally {
        span.end();
      }
    },
  );
}
