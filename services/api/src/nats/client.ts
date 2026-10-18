/**
 * NATS JetStream setup (specs/05-backend-and-jobs.md §4.1).
 *
 * Three things are provisioned idempotently on API boot:
 *
 * - `JOBS`   — work-queue retention on `jobs.>`, one message handed to one worker.
 * - `EVENTS` — limits retention (24 h) on `events.>`, fanned out to the gateway.
 * - the `cancel` KV bucket — `cancel.<jobId>` flags checked by workers (05 §4.4).
 */
import {
  connect,
  type JetStreamManager,
  type NatsConnection,
  RetentionPolicy,
  StorageType,
} from "nats";

import type { Config } from "../config.js";

export const JOBS_STREAM = "JOBS";
export const EVENTS_STREAM = "EVENTS";
export const CANCEL_BUCKET = "cancel";
/**
 * `EVENTS` retention, 24 h (05 §4.1). nats.js passes a stream's `max_age`
 * through to the wire in nanoseconds, so this one is ns.
 */
export const EVENTS_MAX_AGE_NS = 24 * 60 * 60 * 1_000_000_000;
/**
 * The `cancel` KV bucket's TTL, 24 h. KV `ttl` is in **milliseconds** (nats.js
 * converts), unlike the stream's `max_age`, so the two cannot share a constant.
 */
export const CANCEL_TTL_MS = 24 * 60 * 60 * 1000;

export interface NatsLogger {
  info(message: string): void;
}

/** Connects to NATS. The caller owns `nc.close()`. */
export async function connectNats(config: Config): Promise<NatsConnection> {
  return connect({ servers: config.natsUrl, name: "bragi-api" });
}

/** Creates the streams and the KV bucket if they do not exist yet. */
export async function ensureStreams(
  nc: NatsConnection,
  log: NatsLogger = console,
): Promise<JetStreamManager> {
  const jsm = await nc.jetstreamManager();
  if (!(await streamExists(jsm, JOBS_STREAM))) {
    await jsm.streams.add({
      name: JOBS_STREAM,
      subjects: ["jobs.>"],
      retention: RetentionPolicy.Workqueue,
      storage: StorageType.File,
    });
    log.info(`created stream ${JOBS_STREAM}`);
  }
  if (!(await streamExists(jsm, EVENTS_STREAM))) {
    await jsm.streams.add({
      name: EVENTS_STREAM,
      subjects: ["events.>"],
      retention: RetentionPolicy.Limits,
      storage: StorageType.File,
      max_age: EVENTS_MAX_AGE_NS,
    });
    log.info(`created stream ${EVENTS_STREAM}`);
  }
  // `views.kv` creates the bucket when missing and opens it otherwise.
  await nc.jetstream().views.kv(CANCEL_BUCKET, { history: 1, ttl: CANCEL_TTL_MS });
  return jsm;
}

async function streamExists(jsm: JetStreamManager, name: string): Promise<boolean> {
  try {
    await jsm.streams.info(name);
    return true;
  } catch {
    return false;
  }
}

/** The NATS subject a `JobRequest` is published on (05 §4.1). */
export function jobSubject(capability: string, priority: string): string {
  return `jobs.${capability}.${priority}`;
}

/** The subject a `JobEvent` is published on (05 §4.1). */
export function jobEventSubject(jobId: string): string {
  return `events.job.${jobId}`;
}

/** The subject an asset event is published on. */
export function assetEventSubject(hash: string): string {
  return `events.asset.${hash}`;
}
