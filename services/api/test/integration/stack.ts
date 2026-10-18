/**
 * Brings the WP-0.7 services up for the acceptance test.
 *
 * - `compose` (default): the `api` and `worker` services from
 *   `infra/docker-compose.yml`.
 * - `local` (`BRAGI_STACK=local`): the same entrypoints as ordinary processes,
 *   for machines that cannot build the images (a sandbox without registry
 *   access). The infrastructure is still the docker compose one.
 *
 * Either way the services export their spans to the in-test collector.
 *
 * The compose project is shared across worktrees, so this only *starts* the
 * infrastructure services that are not already listening and never stops or
 * removes a container (WP-0.7 infra ownership).
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const COMPOSE_FILE = `${REPO_ROOT}infra/docker-compose.yml`;
const API_DIR = fileURLToPath(new URL("../../", import.meta.url));
const WORKERS_DIR = `${REPO_ROOT}services/workers`;

/** The shared infrastructure services and the host port each is reachable on. */
const INFRA: { name: string; port: number }[] = [
  { name: "postgres", port: 5432 },
  { name: "nats", port: 4222 },
  { name: "minio", port: 9000 },
  { name: "mailpit", port: 1025 },
];

export interface Stack {
  stop(): Promise<void>;
}

/** Brings the API (+ orchestrator) and the worker up, exporting to `otelPort`. */
export async function startStack(otelPort: number): Promise<Stack> {
  await ensureInfra();
  return (process.env.BRAGI_STACK ?? "compose") === "local"
    ? startLocal(otelPort)
    : startCompose(otelPort);
}

function startCompose(otelPort: number): Stack {
  compose(["up", "-d", "--build", "api", "worker"], {
    ...process.env,
    // Inside a container, the host's collector is host.docker.internal.
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://host.docker.internal:${otelPort}`,
  });
  return {
    // Left running on purpose: a test must not tear down shared containers.
    stop: async () => undefined,
  };
}

function startLocal(otelPort: number): Stack {
  const endpoint = `http://127.0.0.1:${otelPort}`;
  const apiEnv = {
    ...process.env,
    NODE_ENV: "development",
    OTEL_ENABLED: "true",
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    API_PORT: process.env.API_PORT ?? "8080",
  };
  const children: ChildProcess[] = [
    spawn("node", ["dist/orchestrator.js"], { cwd: API_DIR, env: apiEnv, stdio: "inherit" }),
    spawn("node", ["dist/server.js"], { cwd: API_DIR, env: apiEnv, stdio: "inherit" }),
    spawn("uv", ["run", "--directory", WORKERS_DIR, "python", "-m", "bragi_analysis"], {
      cwd: REPO_ROOT,
      env: { ...process.env, OTEL_ENABLED: "true", OTEL_EXPORTER_OTLP_ENDPOINT: endpoint },
      stdio: "inherit",
    }),
  ];
  return {
    stop: async () => {
      for (const child of children) child.kill("SIGTERM");
      await Promise.all(children.map(waitForExit));
    },
  };
}

/** Resolves when the child has exited, escalating to SIGKILL after 5 s. */
function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5000);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Starts only the infrastructure services that are not already listening. */
async function ensureInfra(): Promise<void> {
  const missing: string[] = [];
  for (const service of INFRA) {
    if (!(await portOpen(service.port))) missing.push(service.name);
  }
  if (missing.length === 0) return;
  compose(["up", "-d", "--wait", ...missing], process.env);
}

function portOpen(port: number): Promise<boolean> {
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

function compose(args: string[], env: NodeJS.ProcessEnv): void {
  execFileSync("docker", ["compose", "-f", COMPOSE_FILE, ...args], {
    stdio: "inherit",
    cwd: REPO_ROOT,
    env,
  });
}
