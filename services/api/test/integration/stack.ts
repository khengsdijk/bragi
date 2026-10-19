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

export interface StackOptions {
  /** Auth mode for the API (ADR-0014); the local default is single-user. */
  authMode?: "single-user" | "multi-user";
}

/** Brings the API (+ orchestrator) and the worker up, exporting to `otelPort`. */
export async function startStack(otelPort: number, options: StackOptions = {}): Promise<Stack> {
  const authMode = options.authMode ?? "single-user";
  await ensureInfra();
  return (process.env.BRAGI_STACK ?? "compose") === "local"
    ? startLocal(otelPort, authMode)
    : startCompose(otelPort, authMode);
}

function startCompose(otelPort: number, authMode: "single-user" | "multi-user"): Stack {
  compose(["up", "-d", "--build", "api", "worker"], {
    ...process.env,
    // Inside a container, the host's collector is host.docker.internal.
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://host.docker.internal:${otelPort}`,
    BRAGI_AUTH_MODE: authMode,
    // The container binds 0.0.0.0, so single-user needs the override (ADR-0014).
    ...(authMode === "single-user" ? { BRAGI_ALLOW_REMOTE_SINGLE_USER: "1" } : {}),
  });
  return {
    // Left running on purpose: a test must not tear down shared containers.
    stop: async () => undefined,
  };
}

async function startLocal(
  otelPort: number,
  authMode: "single-user" | "multi-user",
): Promise<Stack> {
  const apiPort = Number(process.env.API_PORT ?? "8080");
  if (await portOpen(apiPort)) {
    throw new Error(
      `port ${apiPort} is already in use: stop the running backend (a stale \`pnpm dev:backend\`?) first`,
    );
  }
  const endpoint = `http://127.0.0.1:${otelPort}`;
  // The same launcher as `pnpm dev:backend` (scripts/dev-backend.mjs); the
  // infrastructure was already ensured above.
  const launcher = spawn("node", [`${REPO_ROOT}scripts/dev-backend.mjs`, "--no-infra"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      OTEL_ENABLED: "true",
      OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
      BRAGI_AUTH_MODE: authMode,
    },
    stdio: "inherit",
  });
  return {
    stop: async () => {
      launcher.kill("SIGTERM");
      await waitForExit(launcher, 15_000);
    },
  };
}

/** Resolves when the child has exited, escalating to SIGKILL after 5 s. */
function waitForExit(child: ChildProcess, graceMs = 5000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, graceMs);
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
