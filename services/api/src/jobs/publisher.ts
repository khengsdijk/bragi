/**
 * Publishes `JobRequest`s to NATS JetStream (specs/05 §4.1–§4.2).
 *
 * The envelope is validated against the WP-0.2 schema *before* it leaves the
 * process, so a malformed job can never sit in the queue.
 */
import { type JobRequest, validateJobRequest } from "@bragi/schemas";
import { JSONCodec, type NatsConnection } from "nats";

import { jobEventSubject, jobSubject } from "../nats/client.js";

const jobCodec = JSONCodec<JobRequest>();

/** Publishes a job request on its capability/priority subject. */
export async function publishJobRequest(nc: NatsConnection, job: JobRequest): Promise<void> {
  const payload: unknown = job;
  if (!validateJobRequest(payload)) {
    throw new Error(`refusing to publish an invalid JobRequest for ${job.jobId}`);
  }
  await nc.jetstream().publish(jobSubject(job.capability, job.priority), jobCodec.encode(job));
}

export interface JobEventLike {
  schemaVersion: 1;
  jobId: string;
  type: "started" | "progress" | "partial" | "completed" | "failed";
  pct?: number;
  etaSec?: number;
  outputs?: { assets?: Record<string, string>; blobs?: Record<string, string> };
  error?: { code: string; message: string; retryable: boolean };
}

/** Publishes a job event on `events.job.<jobId>` (05 §4.1). */
export async function publishJobEvent(nc: NatsConnection, event: JobEventLike): Promise<void> {
  await nc
    .jetstream()
    .publish(jobEventSubject(event.jobId), new TextEncoder().encode(JSON.stringify(event)));
}
