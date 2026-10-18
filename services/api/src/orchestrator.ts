/**
 * `api-orchestrator`: same codebase, separate entrypoint (specs/05 §1, §4.4).
 *
 * A durable pull consumer on `events.job.>` records job state and schedules the
 * dependents of each completed analysis stage. It is deliberately the only
 * writer of DAG state, so a worker never needs to know what comes next.
 */
import "./bootstrap-telemetry.js";

import { type JobEvent, validateJobEvent } from "@bragi/schemas";
import { AckPolicy, DeliverPolicy } from "nats";

import { loadConfig } from "./config.js";
import { runMigrations } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { connectNats, EVENTS_STREAM, ensureStreams } from "./nats/client.js";
import { applyJobEvent } from "./orchestrator/handler.js";
import { getTracer, stopTelemetry } from "./telemetry.js";

const ORCHESTRATOR_DURABLE = "orchestrator";

const config = loadConfig();
const pool = createPool(config);
await runMigrations(pool);

const nc = await connectNats(config);
const jsm = await ensureStreams(nc);

if (!(await consumerExists())) {
  await jsm.consumers.add(EVENTS_STREAM, {
    durable_name: ORCHESTRATOR_DURABLE,
    ack_policy: AckPolicy.Explicit,
    filter_subject: "events.job.>",
    deliver_policy: DeliverPolicy.New,
  });
}

const js = nc.jetstream();
const consumer = await js.consumers.get(EVENTS_STREAM, ORCHESTRATOR_DURABLE);
const messages = await consumer.consume();
console.log("api-orchestrator consuming events.job.>");

const tracer = getTracer("bragi-orchestrator");
for await (const message of messages) {
  const payload = safeParse(message.string());
  if (payload === undefined || !validateJobEvent(payload)) {
    message.term();
    continue;
  }
  const event = payload as JobEvent;
  await tracer.startActiveSpan("jobs.orchestrate", async (span) => {
    span.setAttribute("bragi.job.id", event.jobId);
    span.setAttribute("bragi.job.event", event.type);
    try {
      await applyJobEvent({ pool, nc }, event);
      message.ack();
    } catch (error) {
      span.recordException(error as Error);
      message.nak(5_000);
    } finally {
      span.end();
    }
  });
}

async function consumerExists(): Promise<boolean> {
  try {
    await jsm.consumers.info(EVENTS_STREAM, ORCHESTRATOR_DURABLE);
    return true;
  } catch {
    return false;
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function shutdown(signal: string): Promise<void> {
  console.log(`api-orchestrator shutting down (${signal})`);
  await nc.drain();
  await pool.end();
  await stopTelemetry();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
