/**
 * An in-test OTLP/HTTP receiver (specs/05 §11).
 *
 * The API and the worker export OTLP to whatever `OTEL_EXPORTER_OTLP_ENDPOINT`
 * points at. The acceptance test points them at this receiver instead of
 * Jaeger, so the trace assertion needs no external service — the spans arrive
 * in the test process.
 *
 * Two encodings arrive: the JS SDK's HTTP exporter posts OTLP **JSON**, the
 * Python one posts OTLP **protobuf**, so both are decoded here. Only
 * `/v1/traces` is read; `/v1/logs` is acknowledged and ignored.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface CollectedSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  service: string;
}

export class SpanCollector {
  private readonly spans: CollectedSpan[] = [];
  private server: Server | undefined;
  private port = 0;

  /** Starts listening on an ephemeral port and returns its number. */
  async start(): Promise<number> {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    this.port = typeof address === "object" && address !== null ? address.port : 0;
    return this.port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (this.server) this.server.close(() => resolve());
      else resolve();
    });
  }

  /** Every span seen so far. */
  all(): CollectedSpan[] {
    return [...this.spans];
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve) => {
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => resolve());
    });
    if (request.url?.includes("/v1/traces")) {
      try {
        this.spans.push(...decodeOtlpTraces(Buffer.concat(chunks)));
      } catch {
        // A malformed export must not fail the run; the assertion will.
      }
    }
    response.writeHead(200);
    response.end();
  }
}

/**
 * Decodes an OTLP `ExportTraceServiceRequest` in either JSON or protobuf into
 * the spans the test asserts on. Exported so it has its own unit test.
 */
export function decodeOtlpTraces(body: Uint8Array): CollectedSpan[] {
  if (body.length === 0) return [];
  return body[0] === 0x7b /* { */ ? decodeJson(body) : decodeProtobuf(body);
}

// --- OTLP/JSON ---------------------------------------------------------------

interface JsonKeyValue {
  key?: string;
  value?: { stringValue?: string };
}
interface JsonSpan {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  name?: string;
}
interface JsonResourceSpans {
  resource?: { attributes?: JsonKeyValue[] };
  scopeSpans?: { spans?: JsonSpan[] }[];
}
interface JsonRequest {
  resourceSpans?: JsonResourceSpans[];
}

function decodeJson(body: Uint8Array): CollectedSpan[] {
  const request = JSON.parse(Buffer.from(body).toString("utf8")) as JsonRequest;
  const spans: CollectedSpan[] = [];
  for (const resourceSpans of request.resourceSpans ?? []) {
    const service =
      resourceSpans.resource?.attributes?.find((attribute) => attribute.key === "service.name")
        ?.value?.stringValue ?? "unknown";
    for (const scopeSpans of resourceSpans.scopeSpans ?? []) {
      for (const span of scopeSpans.spans ?? []) {
        if (!span.traceId || !span.name) continue;
        spans.push({
          traceId: span.traceId,
          spanId: span.spanId ?? "",
          parentSpanId: span.parentSpanId ?? "",
          name: span.name,
          service,
        });
      }
    }
  }
  return spans;
}

// --- OTLP/protobuf -----------------------------------------------------------
//
// A small reader for the few fields the assertion needs, rather than a decoder
// dependency. Field numbers are from OTLP's `trace.proto`:
//   ExportTraceServiceRequest.resource_spans = 1
//   ResourceSpans.resource = 1, .scope_spans = 2
//   Resource.attributes = 1 (KeyValue); KeyValue.key = 1, .value = 2 (AnyValue)
//   AnyValue.string_value = 1
//   ScopeSpans.spans = 2
//   Span.trace_id = 1, .span_id = 2, .parent_span_id = 4, .name = 5

interface WireField {
  field: number;
  bytes?: Uint8Array;
}

function decodeProtobuf(body: Uint8Array): CollectedSpan[] {
  const spans: CollectedSpan[] = [];
  for (const resourceSpans of repeated(body, 1)) {
    const service = serviceName(resourceSpans) ?? "unknown";
    for (const scopeSpans of repeated(resourceSpans, 2)) {
      for (const span of repeated(scopeSpans, 2)) {
        const traceId = hex(bytes(span, 1));
        const name = text(span, 5);
        if (!traceId || !name) continue;
        spans.push({
          traceId,
          spanId: hex(bytes(span, 2)),
          parentSpanId: hex(bytes(span, 4)),
          name,
          service,
        });
      }
    }
  }
  return spans;
}

function readFields(buffer: Uint8Array): WireField[] {
  const fields: WireField[] = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    const [tag, afterTag] = readVarint(buffer, cursor);
    cursor = afterTag;
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (wire === 0) {
      const [, next] = readVarint(buffer, cursor);
      cursor = next;
      fields.push({ field });
    } else if (wire === 2) {
      const [length, next] = readVarint(buffer, cursor);
      cursor = next;
      fields.push({ field, bytes: buffer.subarray(cursor, cursor + length) });
      cursor += length;
    } else if (wire === 5) {
      cursor += 4;
      fields.push({ field });
    } else if (wire === 1) {
      cursor += 8;
      fields.push({ field });
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`);
    }
  }
  return fields;
}

function readVarint(buffer: Uint8Array, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  let cursor = offset;
  for (;;) {
    const byte = buffer[cursor];
    if (byte === undefined) throw new Error("truncated varint");
    cursor += 1;
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return [result, cursor];
}

/** Every length-delimited field with the given number. */
function repeated(buffer: Uint8Array, field: number): Uint8Array[] {
  return readFields(buffer)
    .filter((candidate) => candidate.field === field && candidate.bytes !== undefined)
    .map((candidate) => candidate.bytes as Uint8Array);
}

function bytes(buffer: Uint8Array, field: number): Uint8Array | undefined {
  return readFields(buffer).find((candidate) => candidate.field === field)?.bytes;
}

function hex(value: Uint8Array | undefined): string {
  return value === undefined ? "" : Buffer.from(value).toString("hex");
}

function text(buffer: Uint8Array, field: number): string | undefined {
  const value = bytes(buffer, field);
  return value === undefined ? undefined : Buffer.from(value).toString("utf8");
}

/** `Resource.service.name`, from the resource's `KeyValue` attributes. */
function serviceName(resourceSpans: Uint8Array): string | undefined {
  const resource = bytes(resourceSpans, 1);
  if (!resource) return undefined;
  for (const keyValue of repeated(resource, 1)) {
    if (text(keyValue, 1) !== "service.name") continue;
    const anyValue = bytes(keyValue, 2);
    return anyValue === undefined ? undefined : text(anyValue, 1);
  }
  return undefined;
}
