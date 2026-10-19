/**
 * WP-1.10: the upload -> analysis flow against the real backend.
 *
 * login (magic link, Mailpit) -> upload the generated 4-minute song (presign,
 * PUT, complete) -> `POST /v1/analyses` (standard) -> `asset:<hash>` over the
 * WebSocket -> an `analysis.partial` for every stage that has a worker -> the
 * derived assets are downloadable -> every stage blob validates against the
 * `@bragi/schemas` validators -> a late subscriber gets the replay snapshot.
 *
 * `describe` calls the LLM via OpenRouter; without `OPENROUTER_API_KEY` it fails, and
 * the test then requires a clean `analysis.failed` for it (nothing is faked).
 *
 *   BRAGI_STACK=local pnpm test:integration
 *
 * Separation needs the `models` group and the pinned weights in `.bragi/models`
 * (see scripts/dev-backend.mjs). Wall-clock timings are printed at the end.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateEmbeddingResult,
  validateHarmonyResult,
  validateIngestResult,
  validateLoudnessEnergyResult,
  validateRhythmResult,
  validateSeparationResult,
  validateStemActivityResult,
  validateStructureResult,
  validateTagResult,
} from "@bragi/schemas";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { implementedStagesForProfile } from "../../src/jobs/dag.js";
import { SpanCollector } from "./collector.js";
import { API_URL, loginViaMagicLink, waitFor } from "./helpers.js";
import { type Stack, startStack } from "./stack.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const LOCAL_ENDPOINT = API_URL.replace("http", "ws");

interface WsMessage {
  t: string;
  stage?: string;
  blob?: string;
  code?: string;
  message?: string;
  [key: string]: unknown;
}

interface Validator {
  (value: unknown): boolean;
  errors?: unknown;
}

/** The validator for each stage's result blob. */
const VALIDATORS: Record<string, Validator> = {
  ingest: validateIngestResult as Validator,
  rhythm: validateRhythmResult as Validator,
  loudness_energy: validateLoudnessEnergyResult as Validator,
  embed_full: validateEmbeddingResult as Validator,
  section_embed: validateEmbeddingResult as Validator,
  stem_embed: validateEmbeddingResult as Validator,
  tag: validateTagResult as Validator,
  separation: validateSeparationResult as Validator,
  structure: validateStructureResult as Validator,
  harmony: validateHarmonyResult as Validator,
  stem_activity: validateStemActivityResult as Validator,
};

let cookie = "";
let collector: SpanCollector;
let stack: Stack;
let workDir = "";

const step = (text: string): boolean => process.stderr.write(`[flow] ${text}\n`);

describe("WP-1.10 upload -> live analysis", () => {
  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), "bragi-flow-"));
    collector = new SpanCollector();
    stack = await startStack(await collector.start());
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

  it("analyses the generated 4-minute song end to end", { timeout: 900_000 }, async () => {
    const stages = implementedStagesForProfile("standard");
    expect(stages).toContain("separation");

    // 1. The generated, deterministic, uncommitted fixture (13 §1.7).
    const wavPath = join(workDir, "song.wav");
    execFileSync("node", [join(REPO_ROOT, "scripts/fixture-song.mjs"), wavPath]);
    const wav = readFileSync(wavPath);
    const hash = `sha256:${createHash("sha256").update(wav).digest("hex")}`;

    await resetAnalysis(hash);
    cookie = await loginViaMagicLink(`flow+${Date.now()}@bragi.test`);

    step("uploading");
    // 2. Upload: presign -> PUT -> complete.
    const tUpload = performance.now();
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
    const tComplete = performance.now();

    // 4. Subscribe (the topic is only allowed once the user owns the asset), then analyse.
    const live = await openSocket();
    live.socket.send(JSON.stringify({ t: "sub", topics: [`asset:${hash}`] }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(live.messages.filter((m) => m.t === "error")).toEqual([]);
    const submitted = await api<{ stages: { stage: string }[] }>("POST", "/v1/analyses", {
      assetHash: hash,
      profile: "standard",
    });
    expect(submitted.stages.map((s) => s.stage).sort()).toEqual([...stages].sort());

    step("analyses submitted");
    // 3. Every stage reports a partial (or, for `describe` without a key, a clean failure).
    const arrival = new Map<string, number>();
    const finish = async (): Promise<void> => {
      await waitFor(
        async () => {
          for (const message of live.messages) {
            if (message.t === "analysis.failed" && message.stage !== "describe") {
              throw new Error(`stage ${message.stage} failed: ${message.code} ${message.message}`);
            }
            if (
              (message.t === "analysis.partial" || message.t === "analysis.failed") &&
              message.stage !== undefined &&
              !arrival.has(message.stage)
            ) {
              arrival.set(message.stage, performance.now() - tComplete);
            }
          }
          return stages.every((stage) => arrival.has(stage)) ? true : undefined;
        },
        720_000,
        `an analysis message for every stage (have ${[...arrival.keys()].join(", ")})`,
      );
    };
    await finish();

    const partials = new Map<string, string>();
    for (const message of live.messages) {
      if (message.t === "analysis.partial" && message.stage && message.blob) {
        partials.set(message.stage, message.blob);
      }
    }
    const failures = live.messages.filter((m) => m.t === "analysis.failed");
    for (const stage of stages.filter((s) => s !== "describe")) {
      expect(partials.has(stage), `analysis.partial for ${stage}`).toBe(true);
    }
    // describe needs the hosted LLM: either it ran, or it failed cleanly.
    if (!partials.has("describe")) {
      const failure = failures.find((m) => m.stage === "describe");
      expect(failure, "describe must fail with analysis.failed, not stall").toBeDefined();
      step(`describe failed: ${failure?.code} ${failure?.message}`);
    }
    expect(failures.filter((m) => m.stage !== "describe")).toEqual([]);

    step("all stages reported");
    // 4. Blobs validate against the schemas.
    const blobs = new Map<string, unknown>();
    for (const [stage, blobHash] of partials) {
      const validator = VALIDATORS[stage];
      if (validator === undefined) continue;
      const blob = await downloadJson(blobHash);
      blobs.set(stage, blob);
      expect(validator(blob), `${stage} blob: ${JSON.stringify(validator.errors)}`).toBe(true);
    }

    step("blobs validated");
    // 5. Derived assets (working asset, stems, residual) are downloadable.
    const ingest = blobs.get("ingest") as { workingAsset: string };
    const separation = blobs.get("separation") as {
      stems: { asset: string }[];
      residual: string;
    };
    expect(separation.stems.length).toBeGreaterThan(0);
    const tDownload = performance.now();
    const downloads: Record<string, number> = {};
    for (const [name, assetHash] of [
      ["workingAsset", ingest.workingAsset],
      ...separation.stems.map((stem, index): [string, string] => [`stem${index}`, stem.asset]),
      ["residual", separation.residual],
    ] as [string, string][]) {
      const bytes = await downloadBytes(assetHash);
      expect(bytes.length, `${name} is non-empty`).toBeGreaterThan(1000);
      downloads[name] = bytes.length;
    }
    const downloadMs = performance.now() - tDownload;

    step("assets downloaded");
    // 6. A late subscriber gets the replay snapshot.
    const late = await openSocket();
    late.socket.send(JSON.stringify({ t: "sub", topics: [`asset:${hash}`] }));
    await waitFor(
      async () =>
        late.messages.filter((m) => m.t === "analysis.partial").length >= partials.size
          ? true
          : undefined,
      15_000,
      "the replay snapshot",
    );
    const replayed = new Map(
      late.messages.filter((m) => m.t === "analysis.partial").map((m) => [m.stage, m.blob]),
    );
    for (const [stage, blob] of partials) expect(replayed.get(stage)).toBe(blob);
    live.socket.close();
    late.socket.close();

    const rows = [...arrival.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([stage, ms]) => `${stage.padEnd(16)} ${(ms / 1000).toFixed(1).padStart(7)} s`);
    step(
      [
        `TIMINGS (presign${presign.exists ? " (dedupe hit, no PUT)" : "+PUT"}+complete ${((tComplete - tUpload) / 1000).toFixed(1)} s; the clock below starts at upload complete; ${wav.length} bytes, standard profile)`,
        ...rows,
        `all stages        ${(Math.max(...arrival.values()) / 1000).toFixed(1).padStart(7)} s`,
        `download ${Object.keys(downloads).length} assets ${(downloadMs / 1000).toFixed(2)} s`,
      ].join("\n"),
    );
  });
});

// --- helpers -----------------------------------------------------------------

/**
 * The fixture is deterministic, so a previous run left finished stages and cached
 * job results for the same hash. Clear them so every run (and every timing) is
 * cold. Only analysis state for this hash is touched; the uploaded asset stays.
 */
async function resetAnalysis(hash: string): Promise<void> {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL ?? "postgres://bragi:bragi@127.0.0.1:5432/bragi",
  });
  try {
    await pool.query(
      `DELETE FROM job_results WHERE idempotency_key IN
         (SELECT idempotency_key FROM jobs WHERE params->>'assetHash' = $1)`,
      [hash],
    );
    await pool.query("DELETE FROM analyses WHERE asset_hash = $1", [hash]);
  } finally {
    await pool.end();
  }
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers: { "content-type": "application/json", cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
  const socket = new WebSocket(`${LOCAL_ENDPOINT}/v1/ws`, { headers: { cookie } });
  const messages: WsMessage[] = [];
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as WsMessage;
    step(`ws ${message.t} ${message.stage ?? ""}`);
    messages.push(message);
  });
  await new Promise<void>((resolve, reject) => {
    socket.on("open", () => resolve());
    socket.on("error", reject);
  });
  return { socket, messages };
}
