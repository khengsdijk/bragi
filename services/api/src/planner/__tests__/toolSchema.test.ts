import { OP_NAMES, PLAN_TOOL_SCHEMA } from "@bragi/schemas";
import { describe, expect, it } from "vitest";

import { plannerOpNames } from "../opSchemas.js";
import { plannerToolSchema } from "../toolSchema.js";

describe("planner tool schema", () => {
  it("keeps the EditPlan envelope and drops the per-op definitions", () => {
    const schema = plannerToolSchema();
    const properties = schema.properties as Record<string, unknown>;
    expect(properties.planId).toBeUndefined();
    expect(properties.interpretation).toBeDefined();
    expect(properties.variants).toBeDefined();
    expect(schema.required).toEqual(["interpretation", "variants"]);
    const defs = schema.$defs as Record<string, unknown>;
    expect(defs.Op).toBeUndefined();
    expect(defs.FxInstance).toBeUndefined();
    expect(defs.PlanVariant).toBeDefined();
    expect(defs.PlanStep).toBeDefined();
  });

  it("describes ops items loosely with the offered op enum", () => {
    const defs = plannerToolSchema().$defs as Record<string, Record<string, unknown>>;
    const step = defs.PlanStep;
    const branches = step?.oneOf as Record<string, Record<string, unknown>>[];
    const ops = branches?.[0];
    const properties = ops?.properties as Record<string, Record<string, unknown>>;
    const items = properties.ops?.items as Record<string, unknown>;
    expect(items.additionalProperties).toBe(true);
    const op = (items.properties as Record<string, Record<string, unknown>>).op;
    expect(op?.enum).toEqual(plannerOpNames());
    expect(plannerOpNames().length).toBeLessThan(OP_NAMES.length);
  });

  it("names the four step kinds and their required keys", () => {
    const defs = plannerToolSchema().$defs as Record<string, Record<string, unknown>>;
    const branches = (defs.PlanStep?.oneOf ?? []) as Record<string, unknown>[];
    const kinds = branches.map((branch) => {
      const properties = branch.properties as Record<string, Record<string, unknown>>;
      const kind = properties.kind as Record<string, unknown>;
      return { kind: (kind.enum as string[])[0], required: branch.required as string[] };
    });
    expect(kinds).toEqual([
      { kind: "ops", required: ["kind", "ops"] },
      { kind: "generate", required: ["kind", "id", "capability", "params", "context"] },
      { kind: "apply_generated", required: ["kind", "from", "placement"] },
      { kind: "smooth", required: ["kind", "region", "tools"] },
    ]);
    // A generate step's params and the region/constraints are validated server-side, not here.
    expect(branches[1]?.additionalProperties).toBe(true);
  });

  it("is far smaller than the full generated tool schema", () => {
    const full = JSON.stringify(PLAN_TOOL_SCHEMA).length;
    const slim = JSON.stringify(plannerToolSchema()).length;
    expect(slim).toBeLessThan(full / 4);
    expect(slim).toBeLessThan(6000);
  });
});
