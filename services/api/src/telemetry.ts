/**
 * OpenTelemetry wiring (specs/05-backend-and-jobs.md §11).
 *
 * The trace that the acceptance test asserts on is:
 *
 *     HTTP SERVER span (auto, node http)
 *        └─ jobs.publish (producer, this file)
 *             └─ jobs.consume (consumer, the Python worker, from `traceparent`)
 *
 * `traceparent` is injected into every `JobRequest` (05 §4.2) and extracted in
 * `bragi_common.telemetry`.
 */

import {
  type Attributes,
  context,
  propagation,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

import type { Config } from "./config.js";

/** A syntactically valid but non-sampling `traceparent` (05 §4.2 pattern). */
export const NOOP_TRACEPARENT = `00-${"0".repeat(32)}-${"0".repeat(16)}-00`;

let sdk: NodeSDK | undefined;

/** The tracer for this service. Safe to call before {@link startTelemetry}. */
export function getTracer(name = "bragi-api") {
  return trace.getTracer(name);
}

/**
 * Starts the OTLP SDK once. Instrumentation must be active *before* the
 * instrumented modules are imported, so this is called from
 * `bootstrap-telemetry.ts`, the first import of each entrypoint.
 *
 * @param config validated configuration
 * @returns the running SDK, or `undefined` when telemetry is disabled
 */
export async function startTelemetry(config: Config): Promise<NodeSDK | undefined> {
  if (!config.otelEnabled || sdk !== undefined) return sdk;
  const exporter = new OTLPTraceExporter({
    url: traceUrl(config.otelEndpoint),
  });
  const instance = new NodeSDK({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: config.otelServiceName }),
    traceExporter: exporter,
    instrumentations: [
      getNodeAutoInstrumentations({
        // Dev-only noise: fs/net events are not part of any interesting trace.
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
    ],
  });
  await instance.start();
  sdk = instance;
  return sdk;
}

/** Flushes and stops the SDK. */
export async function stopTelemetry(): Promise<void> {
  const instance = sdk;
  sdk = undefined;
  if (instance) await instance.shutdown();
}

function traceUrl(endpoint: string): string {
  return endpoint.endsWith("/v1/traces") ? endpoint : `${endpoint.replace(/\/$/, "")}/v1/traces`;
}

/** A W3C `traceparent` for the span currently being recorded, or {@link NOOP_TRACEPARENT}. */
export function currentTraceparent(): string {
  const span = trace.getSpan(context.active());
  if (!span) return NOOP_TRACEPARENT;
  return spanContextToTraceparent(span.spanContext());
}

/** Formats a span context as a W3C `traceparent` (05 §4.2). */
export function spanContextToTraceparent(spanContext: {
  traceId: string;
  spanId: string;
  traceFlags: number;
}): string {
  if (!spanContext.traceId || !spanContext.spanId) return NOOP_TRACEPARENT;
  return `00-${spanContext.traceId}-${spanContext.spanId}-${spanContext.traceFlags
    .toString(16)
    .padStart(2, "0")}`;
}

/** Extracts a remote context from a W3C `traceparent` carrier. */
export function extractTraceparent(traceparent: string) {
  return propagation.extract(context.active(), { traceparent });
}

/**
 * Runs `fn` inside an active span, ending it and recording errors.
 *
 * @param name span name
 * @param attributes initial attributes
 * @param fn body to run inside the span
 */
export async function withActiveSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return getTracer().startActiveSpan(
    name,
    { kind: SpanKind.INTERNAL, attributes },
    async (span) => {
      try {
        return await fn(span);
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}
