import { describe, expect, it } from "vitest";

import { decodeOtlpTraces } from "./integration/collector.js";

const TRACE_ID = "11".repeat(16);
const SPAN_ID = "22".repeat(8);
const PARENT_ID = "33".repeat(8);

describe("decodeOtlpTraces", () => {
  it("decodes the OTLP JSON the JS SDK posts", () => {
    const body = Buffer.from(
      JSON.stringify({
        resourceSpans: [
          {
            resource: {
              attributes: [{ key: "service.name", value: { stringValue: "bragi-api" } }],
            },
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: TRACE_ID,
                    spanId: SPAN_ID,
                    parentSpanId: PARENT_ID,
                    name: "jobs.publish",
                  },
                ],
              },
            ],
          },
        ],
      }),
      "utf8",
    );
    expect(decodeOtlpTraces(body)).toEqual([
      {
        traceId: TRACE_ID,
        spanId: SPAN_ID,
        parentSpanId: PARENT_ID,
        name: "jobs.publish",
        service: "bragi-api",
      },
    ]);
  });

  it("decodes the OTLP protobuf the Python SDK posts", () => {
    const span = Buffer.concat([
      lengthDelimited(1, Buffer.from(TRACE_ID, "hex")),
      lengthDelimited(2, Buffer.from(SPAN_ID, "hex")),
      lengthDelimited(4, Buffer.from(PARENT_ID, "hex")),
      stringField(5, "jobs.consume"),
    ]);
    const anyValue = stringField(1, "bragi-worker");
    const keyValue = Buffer.concat([stringField(1, "service.name"), lengthDelimited(2, anyValue)]);
    const resource = lengthDelimited(1, keyValue);
    const scopeSpans = lengthDelimited(2, span);
    const resourceSpans = Buffer.concat([
      lengthDelimited(1, resource),
      lengthDelimited(2, scopeSpans),
    ]);
    const request = lengthDelimited(1, resourceSpans);

    expect(decodeOtlpTraces(request)).toEqual([
      {
        traceId: TRACE_ID,
        spanId: SPAN_ID,
        parentSpanId: PARENT_ID,
        name: "jobs.consume",
        service: "bragi-worker",
      },
    ]);
  });

  it("ignores an empty body", () => {
    expect(decodeOtlpTraces(new Uint8Array())).toEqual([]);
  });
});

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value;
  do {
    const byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    bytes.push(remaining > 0 ? byte | 0x80 : byte);
  } while (remaining > 0);
  return Buffer.from(bytes);
}

function lengthDelimited(field: number, payload: Buffer): Buffer {
  return Buffer.concat([varint(field * 8 + 2), varint(payload.length), payload]);
}

function stringField(field: number, value: string): Buffer {
  return lengthDelimited(field, Buffer.from(value, "utf8"));
}
