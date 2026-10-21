/**
 * WP-2.7 D: `POST /v1/jobs` with `generate.extend` against the live local stack.
 *
 * Upload a generated 12 s context -> submit with the fake backend -> `job.partial`
 * over the WebSocket, whose `outputs` carry the candidate asset *and* its gate
 * result blob -> `job.completed` -> the result blob validates against
 * `generate.extend-result.schema.json` and both hashes are downloadable (the server
 * registered ownership on the partial, not only on completion).
 *
 * The context is the fake backend's own synthesis (run through the workers'
 * virtualenv), so no audio is committed (13 §1.7). `BRAGI_STACK=local` and
 * `BRAGI_GENERATION_BACKEND=fake` are required; the stack must not already be
 * running on `API_PORT`.
 *
 *   BRAGI_STACK=local BRAGI_GENERATION_BACKEND=fake API_PORT=8081 \
 *     API_URL=http://127.0.0.1:8081 pnpm test:integration
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { validateGenerateExtendResult } from "@bragi/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { SpanCollector } from "./collector.js";
import { API_URL, waitFor } from "./helpers.js";
import { type Stack, startStack } from "./stack.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const WS_URL = API_URL.replace("http", "ws");

const CONTEXT_SECONDS = 12;
const BARS = 4;
const OVERLAP_BARS = 2;
const CANDIDATES = 3;

interface WsMessage {
  t: string;
  jobId?: string;
  outputs?: {
    assets?: Record<string, string>;
    blobs?: Record<string, string>;
  };
  error?: { code: string; message: string };
  [key: string]: unknown;
}

let stack: Stack;
let collector: SpanCollector;
let workDir = "";

const step = (text: string): boolean => process.stderr.write(`[generate] ${text}\n`);

describe("WP-2.7 generate.extend submit -> partials -> completed", () => {
  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), "bragi-generate-"));
    // The generation worker reads this at call time (09 §3.1): no model needed.
    process.env.BRAGI_GENERATION_BACKEND = "fake";
    collector = new SpanCollector();
    stack = await startStack(await collector.start(), { authMode: "single-user" });
    await waitFor(
      async () => {
        try {
          return (await fetch(`${API_URL}/v1/health`)).ok ? true : undefined;
        } catch {
          return undefined;
        }
      },
      180_000,
      "API health",
    );
  });

  afterAll(async () => {
    await stack?.stop();
    await collector?.stop();
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("streams the candidates and completes", { timeout: 300_000 }, async () => {
    const wav = readFileSync(renderContext(workDir));
    const hash = `sha256:${createHash("sha256").update(wav).digest("hex")}`;

    const presign = await api<{ exists: boolean; uploadUrl?: string }>(
      "POST",
      "/v1/assets/presign",
      { hash, bytes: wav.length, mime: "audio/wav" },
    );
    if (!presign.exists) {
      const put = await fetch(String(presign.uploadUrl), {
        method: "PUT",
        headers: { "content-type": "audio/wav" },
        body: new Uint8Array(wav),
      });
      expect(put.ok).toBe(true);
    }
    await api("POST", `/v1/assets/${hash}/complete`, { mime: "audio/wav" });
    step("context uploaded");

    const live = await openSocket();
    // Subscribe after submit: the `job:` topic only exists once the row does (05 §3).
    const submitted = await api<{
      jobId: string;
      status: string;
      createdAt: string;
      estimatedCredits: number;
    }>("POST", "/v1/jobs", {
      capability: "generate.extend",
      priority: "interactive",
      assets: { context: hash },
      params: {
        context: {
          bpm: 120,
          timeSignature: [4, 4],
          key: { tonic: "A", mode: "minor" },
          descriptors: ["warm analog synths"],
          seed: 1234,
        },
        bars: BARS,
        overlapBars: OVERLAP_BARS,
        direction: "forward",
        tier: "preview",
        n: CANDIDATES,
      },
    });
    expect(submitted.status).toBe("queued");
    // 4 bars at 120 BPM in 4/4 = 8 s = one 30 s window, 2 credits × 3 candidates.
    expect(submitted.estimatedCredits).toBe(2 * CANDIDATES);
    live.socket.send(JSON.stringify({ t: "sub", topics: [`job:${submitted.jobId}`] }));
    step(`submitted ${submitted.jobId} (${submitted.estimatedCredits} credits)`);

    const partials = await waitFor(
      async () => {
        const seen = live.messages.filter((m) => m.t === "job.partial");
        return seen.length >= CANDIDATES ? seen : undefined;
      },
      180_000,
      `${CANDIDATES} job.partial events`,
    );

    for (const message of partials) {
      expect(message.outputs?.assets).toBeDefined();
      expect(message.outputs?.blobs).toBeDefined();
      const key = Object.keys(message.outputs?.assets ?? {})[0] ?? "";
      expect(key).toMatch(/^candidate_\d$/);
      expect(message.outputs?.assets?.[key]).toMatch(/^sha256:/);
      expect(message.outputs?.blobs?.[key]).toMatch(/^sha256:/);
    }
    step(`got ${partials.length} partials`);

    const completed = await waitFor(
      async () => {
        const message = live.messages.find((m) => m.t === "job.completed");
        if (message === undefined) return undefined;
        if (message.outputs === undefined) throw new Error("completed without outputs");
        return message;
      },
      180_000,
      "job.completed",
    );
    live.socket.close();

    const outputs = completed.outputs;
    expect(Object.keys(outputs?.assets ?? {}).sort()).toEqual([
      "candidate_0",
      "candidate_1",
      "candidate_2",
    ]);
    expect(Object.keys(outputs?.blobs ?? {}).sort()).toEqual([
      "candidate_0",
      "candidate_1",
      "candidate_2",
    ]);

    // The partial's blob and asset are owned and readable, and the blob validates.
    const first = partials[0];
    const blobHash = first?.outputs?.blobs?.candidate_0 ?? "";
    const assetHash = first?.outputs?.assets?.candidate_0 ?? "";
    const blob = await downloadJson(blobHash);
    expect(
      validateGenerateExtendResult(blob),
      JSON.stringify(validateGenerateExtendResult.errors),
    ).toBe(true);
    expect((await downloadBytes(assetHash)).length).toBeGreaterThan(1_000);
    step("artifact and blob readable, blob valid");
  });

  it("answers the warm-up ping", { timeout: 60_000 }, async () => {
    const first = await api<{ status: string }>("POST", "/v1/generations/warmup");
    expect(["warming", "warm"]).toContain(first.status);
    const second = await api<{ status: string }>("POST", "/v1/generations/warmup");
    expect(["warming", "warm"]).toContain(second.status);
    step(`warm-up: ${first.status} then ${second.status}`);
  });
});

// --- helpers -----------------------------------------------------------------

/**
 * Writes the fake backend's own 12 s, 120 BPM, A-minor loop as a 48 kHz WAV.
 *
 * Reusing the backend's synthesis is what makes the real quality gates accept the
 * continuation; the fixture is generated here and never committed.
 */
function renderContext(directory: string): string {
  const path = join(directory, "context.wav");
  const script = [
    "import sys",
    "from bragi_generate.audio import encode_wav",
    "from bragi_generate.backends.fake import synthesize",
    "from bragi_generate.postprocess.types import KeySpec",
    "audio = synthesize(120.0, (4, 4), KeySpec.parse('A', 'minor'),",
    `    start_sec=0.0, duration_sec=${CONTEXT_SECONDS}, seed=99)`,
    "open(sys.argv[1], 'wb').write(encode_wav(audio))",
  ].join("\n");
  execFileSync(
    "uv",
    ["run", "--directory", join(REPO_ROOT, "services/workers"), "python", "-c", script, path],
    { cwd: REPO_ROOT, stdio: "inherit" },
  );
  return path;
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!response.ok)
    throw new Error(`${method} ${path} -> ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

async function downloadBytes(hash: string): Promise<Buffer> {
  const { url } = await api<{ url: string }>("GET", `/v1/assets/${hash}/url`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download ${hash} -> ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function downloadJson(hash: string): Promise<unknown> {
  return JSON.parse((await downloadBytes(hash)).toString("utf8"));
}

async function openSocket(): Promise<{ socket: WebSocket; messages: WsMessage[] }> {
  const socket = new WebSocket(`${WS_URL}/v1/ws`);
  const messages: WsMessage[] = [];
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as WsMessage;
    step(`ws ${message.t}`);
    messages.push(message);
  });
  await new Promise<void>((resolve, reject) => {
    socket.on("open", () => resolve());
    socket.on("error", reject);
  });
  return { socket, messages };
}
