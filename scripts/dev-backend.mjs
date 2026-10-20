#!/usr/bin/env node
/**
 * `pnpm dev:backend`: the local backend as ordinary processes (specs/13 §9).
 *
 *   1. ensures the docker compose infrastructure is up (Postgres, MinIO, NATS,
 *      Mailpit; only what is not already listening, never stops or removes a container),
 *   2. builds `services/api` if `dist/` is missing,
 *   3. runs the API HTTP server, the orchestrator and the Python analysis worker
 *      (every capability in `services/workers`), each with a prefixed log,
 *   4. shuts everything down on Ctrl-C / SIGTERM, or when any process exits.
 *
 * Separation needs the `models` group and the pinned weights. Fetch them once
 * (never committed, `.bragi/` is gitignored):
 *
 *   uv run --directory services/workers --group models \
 *     python -m bragi_analysis.separation.weights .bragi/models
 *
 * Options: `--no-infra` skips step 1 (the integration test checks it itself).
 * Env: `BRAGI_MODELS_DIR` (default `.bragi/models` when it exists),
 * `API_PORT`, and any OTEL_* variable, passed through unchanged. Secrets such as
 * `OPENROUTER_API_KEY` can live in the git-ignored `.env` (see `.env.example`) or
 * `infra/.env`: both are read at start, `.env` first, and never override a value
 * already exported in the shell; empty values are skipped.
 *
 * The API runs single-user by default: `BRAGI_AUTH_MODE` defaults to
 * `single-user` and `API_HOST` to `127.0.0.1` (loopback, which single-user mode
 * requires) unless either is already set. Set `BRAGI_AUTH_MODE=multi-user` (and
 * `API_HOST=0.0.0.0`) to get the Better Auth flow locally. The values are passed
 * to the orchestrator too, harmlessly.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API_DIR = join(ROOT, "services", "api");
const WORKERS_DIR = join(ROOT, "services", "workers");
const COMPOSE_FILE = join(ROOT, "infra", "docker-compose.yml");

/**
 * Fills `process.env` from the local env files: the root `.env`, then `infra/.env`. A variable
 * already set (by the shell or an earlier file) wins, and an empty value is skipped so a blank
 * template line never shadows a default.
 */
function loadLocalEnv() {
  for (const file of [join(ROOT, ".env"), join(ROOT, "infra", ".env")]) {
    if (!existsSync(file)) continue;
    for (const [name, value] of Object.entries(parseEnv(readFileSync(file, "utf8")))) {
      if (value !== "" && process.env[name] === undefined) process.env[name] = value;
    }
  }
}

/** @type {Record<string, number>} */
const COLOURS = { api: 36, orchestrator: 35, worker: 33 };

/**
 * Spawns a child whose stdout/stderr lines are prefixed with its name.
 *
 * @param {string} name
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd: string, env: NodeJS.ProcessEnv }} options
 */
function run(name, command, args, { cwd, env }) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // own process group, so the whole tree can be signalled
  });
  const prefix = `\u001b[${COLOURS[name] ?? 37}m[${name}]\u001b[0m `;
  for (const stream of [child.stdout, child.stderr]) {
    let pending = "";
    stream.on("data", (chunk) => {
      pending += chunk.toString();
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) process.stdout.write(`${prefix}${line}\n`);
    });
    stream.on("end", () => {
      if (pending) process.stdout.write(`${prefix}${pending}\n`);
    });
  }
  return child;
}

/**
 * @param {import("node:child_process").ChildProcess} child
 * @param {NodeJS.Signals} signal
 */
function signalGroup(child, signal) {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // already gone
  }
}

/** The infrastructure the backend needs, and the host port each listens on. */
const INFRA = [
  { name: "postgres", port: 5432 },
  { name: "nats", port: 4222 },
  { name: "minio", port: 9000 },
  { name: "mailpit", port: 1025 },
];

/**
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function portOpen(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.setTimeout(500);
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("error", () => resolve(false));
  });
}

/**
 * Starts only the infrastructure services that are not already listening
 * (Jaeger and the like are optional and never pulled here). Never stops or
 * removes a container: the compose project is shared across worktrees.
 */
async function ensureInfra() {
  /** @type {string[]} */
  const missing = [];
  for (const service of INFRA) {
    if (!(await portOpen(service.port))) missing.push(service.name);
  }
  if (missing.length === 0) return;
  console.log(`[dev:backend] starting infrastructure: ${missing.join(", ")}`);
  execFileSync(
    "docker",
    ["compose", "-f", COMPOSE_FILE, "up", "-d", "--wait", "--wait-timeout", "180", ...missing],
    { stdio: "inherit", cwd: ROOT },
  );
}

async function main() {
  if (!process.argv.includes("--no-infra")) await ensureInfra();
  if (!existsSync(join(API_DIR, "dist", "server.js"))) {
    console.log("[dev:backend] building services/api");
    execFileSync("pnpm", ["--filter", "@bragi/api", "build"], { stdio: "inherit", cwd: ROOT });
  }

  // biome-ignore lint/suspicious/noUndeclaredEnvVars: a dev launcher, not a cached turbo task
  const modelsDir = process.env.BRAGI_MODELS_DIR ?? join(ROOT, ".bragi", "models");
  /** @type {NodeJS.ProcessEnv} */
  const workerEnv = { ...process.env, PYTHONUNBUFFERED: "1" };
  if (existsSync(modelsDir)) workerEnv.BRAGI_MODELS_DIR = modelsDir;
  else console.warn(`[dev:backend] no separation weights at ${modelsDir}; separation will fail`);

  const apiEnv = {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV ?? "development",
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: a dev launcher, not a cached turbo task
    API_PORT: process.env.API_PORT ?? "8080",
    // Single-user by default, on loopback; see the header comment (ADR-0014).
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: a dev launcher, not a cached turbo task
    API_HOST: process.env.API_HOST ?? "127.0.0.1",
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: a dev launcher, not a cached turbo task
    BRAGI_AUTH_MODE: process.env.BRAGI_AUTH_MODE ?? "single-user",
  };
  const children = [
    run("orchestrator", "node", ["dist/orchestrator.js"], { cwd: API_DIR, env: apiEnv }),
    run("api", "node", ["dist/server.js"], { cwd: API_DIR, env: apiEnv }),
    run(
      "worker",
      "uv",
      ["run", "--directory", WORKERS_DIR, "--group", "models", "python", "-m", "bragi_analysis"],
      { cwd: ROOT, env: workerEnv },
    ),
  ];

  let stopping = false;
  /** @param {number} code */
  const stop = (code) => {
    if (stopping) return;
    stopping = true;
    for (const child of children) signalGroup(child, "SIGTERM");
    const timer = setTimeout(() => {
      for (const child of children) signalGroup(child, "SIGKILL");
      process.exit(code);
    }, 8000);
    Promise.all(
      children.map(
        (child) =>
          new Promise((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) resolve(undefined);
            else child.on("exit", () => resolve(undefined));
          }),
      ),
    ).then(() => {
      clearTimeout(timer);
      process.exit(code);
    });
  };
  process.on("SIGINT", () => stop(0));
  process.on("SIGTERM", () => stop(0));
  for (const child of children) {
    child.on("exit", (code, signal) => {
      if (!stopping) {
        console.error(`[dev:backend] a process exited (${signal ?? code}); stopping the rest`);
        stop(1);
      }
    });
  }
  console.log("[dev:backend] running; Ctrl-C to stop");
}

loadLocalEnv();
await main();
