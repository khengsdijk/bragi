/**
 * Must be the **first** import of every process entrypoint.
 *
 * OpenTelemetry's instrumentation patches modules at `require` time, so the SDK
 * has to be running before `fastify`, `pg` or `nats` are imported. Importing
 * this module first (it only depends on `config` and `telemetry`) guarantees
 * that, because ESM evaluates dependencies in import order.
 */
import { loadConfig } from "./config.js";
import { startTelemetry } from "./telemetry.js";

await startTelemetry(loadConfig());
