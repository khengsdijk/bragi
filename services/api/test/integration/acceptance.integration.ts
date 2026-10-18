/**
 * WP-0.7 acceptance: log in, upload, run an `echo` job, watch it over the
 * WebSocket, and prove one OpenTelemetry trace spans API → NATS → worker.
 *
 * Run it against the docker compose stack (see vitest.integration.config.ts),
 * or with `BRAGI_STACK=local` to run the same entrypoints as processes:
 *
 *   docker compose -f infra/docker-compose.yml up -d --wait
 *   pnpm test:integration
 *   BRAGI_STACK=local pnpm test:integration
 */
import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { SpanCollector } from "./collector.js";
import { type Stack, startStack } from "./stack.js";

const API_URL = process.env.API_URL ?? "http://127.0.0.1:8080";
const MAILPIT_URL = process.env.MAILPIT_URL ?? "http://127.0.0.1:8025";

/** The session cookie, set by the login step and reused by `api()`. */
let cookie = "";
let collector: SpanCollector;
let stack: Stack;

interface WsMessage {
  t: string;
  [key: string]: unknown;
}

describe("WP-0.7 acceptance", () => {
  beforeAll(async () => {
    collector = new SpanCollector();
    const port = await collector.start();
    stack = await startStack(port);
    await waitFor(
      async () => {
        try {
          return (await fetch(`${API_URL}/v1/health`)).ok ? true : undefined;
        } catch {
          return undefined;
        }
      },
      120_000,
      "API health",
    );
  });

  afterAll(async () => {
    await stack?.stop();
    await collector?.stop();
  });

  it("logs in, uploads, runs an echo job and shows one trace", async () => {
    const email = `agent+${Date.now()}@bragi.test`;

    // 1. Magic link via Mailpit (the GitHub path needs the owner's OAuth app).
    cookie = await loginViaMagicLink(email);
    expect(cookie).toContain("better-auth.session_token=");

    // 2. Upload a generated (licence-clean) WAV through presign → PUT → complete.
    //    The payload varies per run so the upload path is always exercised.
    const wav = makeWav(Date.now());
    const hash = `sha256:${createHash("sha256").update(wav).digest("hex")}`;
    const presign = await api<{ exists: boolean; uploadUrl?: string }>(
      "POST",
      "/v1/assets/presign",
      { hash, bytes: wav.length, mime: "audio/wav" },
    );
    if (presign.exists) {
      // Only possible if this exact payload was uploaded before; dedupe is a
      // feature (05 §6), so the test still passes without a second PUT.
      expect(presign.uploadUrl).toBeUndefined();
    } else {
      expect(presign.uploadUrl).toBeTruthy();
      const put = await fetch(String(presign.uploadUrl), {
        method: "PUT",
        headers: { "content-type": "audio/wav" },
        body: wav,
      });
      expect(put.ok).toBe(true);
    }
    const completed = await api<{ hash: string; bytes: number }>(
      "POST",
      `/v1/assets/${hash}/complete`,
      { mime: "audio/wav" },
    );
    expect(completed.hash).toBe(hash);
    expect(completed.bytes).toBe(wav.length);

    // 3. Subscribe over the WebSocket, then submit an `echo` job (the echo
    //    parameters are chosen so the job is not a result-cache hit).
    const socket = new WebSocket(`${API_URL.replace("http", "ws")}/v1/ws`, {
      headers: { cookie },
    });
    const messages: WsMessage[] = [];
    const finished = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no job.completed in 30s")), 30_000);
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString()) as WsMessage;
        messages.push(message);
        if (message.t === "job.completed" || message.t === "job.failed") {
          clearTimeout(timer);
          resolve();
        }
      });
      socket.on("error", reject);
    });
    await new Promise<void>((resolve, reject) => {
      socket.on("open", () => resolve());
      socket.on("error", reject);
    });

    const submitted = await api<{ jobId: string }>("POST", "/v1/jobs", {
      capability: "echo",
      assets: { source: hash },
      params: { steps: 6, delay_ms: 400 },
    });
    socket.send(JSON.stringify({ t: "sub", topics: [`job:${submitted.jobId}`] }));
    await finished;
    socket.close();

    // 4. The events that reached the client.
    const types = messages.map((message) => message.t);
    expect(types).toContain("job.progress");
    expect(types).toContain("job.completed");
    const progress = messages.find((message) => message.t === "job.progress");
    expect(progress?.stage).toBe("echo");
    const completedMessage = messages.find((message) => message.t === "job.completed");
    const outputs = completedMessage?.outputs as
      | { assets?: Record<string, string>; blobs?: Record<string, string> }
      | undefined;
    expect(outputs?.assets?.source).toBe(hash);
    expect(outputs?.blobs?.manifest).toMatch(/^sha256:[0-9a-f]{64}$/);

    // 5. The orchestrator persisted the final state.
    const job = await waitFor(
      async () => {
        const current = await api<{ status: string; outputs: unknown }>(
          "GET",
          `/v1/jobs/${submitted.jobId}`,
        );
        return current.status === "done" ? current : undefined;
      },
      20_000,
      "the orchestrator to finish the job",
    );
    expect(job.outputs).toBeTruthy();

    // 6. One trace spans the API and the worker: the worker's `jobs.consume`
    //    span is a child of the API's `jobs.publish`, which carried the
    //    `traceparent` in the JobRequest (05 §4.2, §11).
    const trace = await waitFor(
      async () => {
        const spans = collector.all();
        const candidates = new Set(
          spans
            .filter((span) => span.service === "bragi-worker" && span.name === "jobs.consume")
            .map((span) => span.traceId),
        );
        for (const traceId of candidates) {
          const inTrace = spans.filter((span) => span.traceId === traceId);
          const services = new Set(inTrace.map((span) => span.service));
          const operations = new Set(inTrace.map((span) => span.name));
          if (
            services.has("bragi-api") &&
            services.has("bragi-worker") &&
            operations.has("jobs.publish") &&
            operations.has("jobs.consume")
          ) {
            return inTrace;
          }
        }
        return undefined;
      },
      30_000,
      "a trace spanning the API and the worker",
    );
    expect(new Set(trace.map((span) => span.service))).toEqual(
      new Set(["bragi-api", "bragi-worker"]),
    );
    const publish = trace.find((span) => span.name === "jobs.publish");
    const consume = trace.find((span) => span.name === "jobs.consume");
    expect(publish).toBeDefined();
    expect(consume?.parentSpanId).toBe(publish?.spanId);
  });
});

// --- helpers -----------------------------------------------------------------

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers: { "content-type": "application/json", cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}`);
  return (await response.json()) as T;
}

/** Requests a magic link, reads it from Mailpit, and returns the session cookie. */
async function loginViaMagicLink(email: string): Promise<string> {
  const request = await fetch(`${API_URL}/v1/auth/sign-in/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, callbackURL: `${API_URL}/v1/meta` }),
  });
  expect(request.ok).toBe(true);

  const verifyUrl = await waitFor(
    async () => {
      const listing = await fetch(`${MAILPIT_URL}/api/v1/messages?limit=50`);
      const body = (await listing.json()) as {
        messages?: { ID: string; To?: { Address: string }[] }[];
      };
      const message = body.messages?.find((candidate) =>
        candidate.To?.some((to) => to.Address === email),
      );
      if (!message) return undefined;
      const detail = await fetch(`${MAILPIT_URL}/api/v1/message/${message.ID}`);
      const text = ((await detail.json()) as { Text?: string }).Text ?? "";
      return /https?:\/\/\S+/.exec(text)?.[0];
    },
    15_000,
    "the magic link email",
  );
  expect(verifyUrl).toContain("/v1/auth/magic-link/verify");

  const verified = await fetch(verifyUrl, { redirect: "manual" });
  const cookies = verified.headers.getSetCookie();
  const session = cookies.find((value) => value.startsWith("better-auth.session_token="));
  if (!session) throw new Error("no session cookie from the magic-link verification");
  return session.split(";")[0] ?? "";
}

/** A tiny, self-made 16-bit PCM WAV (no committed audio, 13 §1). */
function makeWav(seed: number): Buffer {
  const sampleRate = 8000;
  const samples = 800;
  const frequency = 200 + (seed % 60);
  const data = Buffer.alloc(samples * 2);
  // The seed makes every run's payload (and therefore its hash) unique, so the
  // upload path is exercised instead of hitting the dedupe branch.
  data.writeUInt32LE(seed >>> 0, 0);
  for (let index = 2; index < samples; index += 1) {
    const value = Math.round(Math.sin((index / sampleRate) * 2 * Math.PI * frequency) * 8000);
    data.writeInt16LE(value, index * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Polls `fn` until it returns a value, or fails after `timeoutMs`. */
async function waitFor<T>(
  fn: () => Promise<T | undefined>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
