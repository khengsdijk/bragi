import { describe, expect, it } from "vitest";

import { normalizePlanEnvelope, parseModelJson } from "../json.js";

describe("parseModelJson", () => {
  it("parses plain JSON and a Markdown fence", () => {
    expect(parseModelJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
});

describe("normalizePlanEnvelope", () => {
  it("parses variants, steps and ops delivered as JSON strings", () => {
    const raw = {
      interpretation: "A small change.",
      variants: JSON.stringify([
        {
          label: "Subtle",
          description: "Less of it.",
          steps: JSON.stringify([
            {
              kind: "ops",
              ops: JSON.stringify([
                {
                  op: "fx.add",
                  scope: { kind: "track", trackId: "trk_drums" },
                  fx: { id: "fx_1", type: "eq3", params: {}, bypass: false },
                },
              ]),
            },
          ]),
        },
      ]),
    };

    expect(normalizePlanEnvelope(raw)).toEqual({
      interpretation: "A small change.",
      variants: [
        {
          label: "Subtle",
          description: "Less of it.",
          steps: [
            {
              kind: "ops",
              ops: [
                {
                  op: "fx.add",
                  scope: { kind: "track", trackId: "trk_drums" },
                  fx: { id: "fx_1", type: "eq3", params: {}, bypass: false },
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it("recovers the array when the provider appends junk after it", () => {
    const raw = {
      interpretation: "x",
      variants: '[{"label":"a","description":"b","steps":[]}]\n\n}',
    };
    expect(normalizePlanEnvelope(raw)).toEqual({
      interpretation: "x",
      variants: [{ label: "a", description: "b", steps: [] }],
    });
  });

  it("leaves a string that is not a JSON array for the schema to reject", () => {
    const raw = { interpretation: "x", variants: "not json" };
    expect(normalizePlanEnvelope(raw)).toEqual(raw);
    expect(normalizePlanEnvelope({ interpretation: "x", variants: '{"a":1}' })).toEqual({
      interpretation: "x",
      variants: '{"a":1}',
    });
  });

  it("never rewrites op contents", () => {
    const op = { op: "fx.add", trackId: "trk_vox", fx: { id: "fx_1", type: "eq3" } };
    const normalized = normalizePlanEnvelope({
      interpretation: "x",
      variants: [{ label: "a", description: "b", steps: [{ kind: "ops", ops: [op] }] }],
    }) as { variants: { steps: { ops: unknown[] }[] }[] };
    expect(normalized.variants[0]?.steps[0]?.ops[0]).toEqual(op);
  });

  it("returns a non-object reply unchanged", () => {
    expect(normalizePlanEnvelope(null)).toBeNull();
    expect(normalizePlanEnvelope("nope")).toBe("nope");
  });
});
