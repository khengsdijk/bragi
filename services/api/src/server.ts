/** `api-http`: the REST + WebSocket process (specs/05 §1). */
import "./bootstrap-telemetry.js";

import { buildApp } from "./app.js";
import { createAuth } from "./auth/auth.js";
import { createSessionResolver } from "./auth/session.js";
import { assertSafeBinding, ensureOwner, type OwnerUser } from "./auth/single-user.js";
import { loadConfig } from "./config.js";
import { runMigrations } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { creditsConfig } from "./jobs/credits.js";
import { connectNats, ensureStreams } from "./nats/client.js";
import { createObjectStore } from "./s3/client.js";
import { stopTelemetry } from "./telemetry.js";

const config = loadConfig();
// A missing or malformed credit table must fail the process, not charge 0 later
// (05 §9). Parsing is cached for the submit path.
creditsConfig(config.creditsConfig);
const pool = createPool(config);
await runMigrations(pool);

// Single-user mode has one owner account, created here (idempotently) and used
// by the session resolver below (ADR-0014, 05 §8).
let owner: OwnerUser | undefined;
if (config.authMode === "single-user") owner = await ensureOwner(pool, config);

const nc = await connectNats(config);
await ensureStreams(nc);

const store = createObjectStore(config);
const { auth, mailer } = createAuth(config, pool);
const sessions = createSessionResolver({
  mode: config.authMode,
  authApi: auth.api,
  ...(owner === undefined ? {} : { owner }),
});
const { app, gateway } = await buildApp({
  config,
  pool,
  nc,
  store,
  auth,
  sessions,
  ...(owner === undefined ? {} : { owner: { id: owner.id, email: owner.email, name: owner.name } }),
});

// Refuse a reachable single-user bind, loudly. The app exists only so the
// refusal uses its logger; it has not listened yet.
try {
  assertSafeBinding(config, { warn: (message) => app.log.warn(message) });
} catch (error) {
  app.log.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

gateway.start();

await app.listen({ host: config.apiHost, port: config.apiPort });
app.log.info(
  {
    port: config.apiPort,
    env: config.nodeEnv,
    otelEnabled: config.otelEnabled,
    otelEndpoint: config.otelEndpoint,
  },
  "api-http listening",
);
app.log.info({ mode: config.authMode, ownerEmail: owner?.email ?? null }, "auth mode");

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  await gateway.stop();
  await app.close();
  mailer.close();
  await nc.drain();
  await pool.end();
  await stopTelemetry();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
