/** `api-http`: the REST + WebSocket process (specs/05 §1). */
import "./bootstrap-telemetry.js";

import { buildApp } from "./app.js";
import { createAuth } from "./auth/auth.js";
import { loadConfig } from "./config.js";
import { runMigrations } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { connectNats, ensureStreams } from "./nats/client.js";
import { createObjectStore } from "./s3/client.js";
import { stopTelemetry } from "./telemetry.js";

const config = loadConfig();
const pool = createPool(config);
await runMigrations(pool);

const nc = await connectNats(config);
await ensureStreams(nc);

const store = createObjectStore(config);
const { auth, mailer } = createAuth(config, pool);
const { app, gateway } = await buildApp({ config, pool, nc, store, auth });
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
