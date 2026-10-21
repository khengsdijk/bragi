import { OP_VALIDATORS } from "@bragi/schemas";
import { describe, expect, it } from "vitest";

import { opShapesText, plannerOpNames, sampleOp } from "../opSchemas.js";

describe("op shapes", () => {
  it("offers the planner ops and not the document-shaped or system ones", () => {
    const ops = plannerOpNames();
    expect(ops).toContain("fx.add");
    expect(ops).toContain("automation.set");
    expect(ops).toContain("region.clear");
    expect(ops).not.toContain("analysis.apply");
    expect(ops).not.toContain("clip.add");
    expect(ops).not.toContain("track.add");
  });

  it("samples a valid example for every offered op", () => {
    for (const op of plannerOpNames()) {
      const example = sampleOp(op);
      expect(OP_VALIDATORS[op], op).toBeDefined();
      expect(OP_VALIDATORS[op]?.(example), `${op}: ${JSON.stringify(example)}`).toBe(true);
    }
  });

  it("puts one generated line per op and the time-limited pattern in the block", () => {
    const text = opShapesText();
    expect(text).toMatchSnapshot();
    for (const op of plannerOpNames()) expect(text).toContain(`  ${op}`);
    expect(text).toContain('"scope":{"kind":"lane"');
    expect(text).toContain('"target":"fx:fx_1/');
  });
});
