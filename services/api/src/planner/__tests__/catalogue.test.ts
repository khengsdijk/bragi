import { describe, expect, it } from "vitest";

import { buildCatalogue, catalogueText } from "../catalogue.js";

describe("capability catalogue", () => {
  it("matches the generated DSP catalogues and capability schemas", () => {
    expect(buildCatalogue()).toMatchSnapshot();
  });

  it("lists fx ranges and macros, and does not repeat the op shapes", () => {
    const catalogue = buildCatalogue();
    expect(catalogue.fx.filter?.cutoffHz).toEqual({ min: 20, max: 20000, default: 20000 });
    expect(Object.keys(catalogue.macros).length).toBeGreaterThan(0);
    expect(catalogueText()).not.toContain('"ops"');
  });

  it("offers the three executable generation capabilities, with prices", () => {
    const generation = buildCatalogue().generation;
    expect(Object.keys(generation.capabilities)).toEqual([
      "generate.extend",
      "generate.inpaint",
      "generate.transition",
    ]);
    expect(generation.capabilities["generate.extend"]?.cost).toBe("2/30s per candidate");
    expect(generation.capabilities["generate.inpaint"]?.cost).toBe("2/30s per candidate");
    expect(generation.capabilities["generate.transition"]?.cost).toBe("1/candidate");
    // Each capability carries only its own params; the model writes `params.context.key` and the
    // server fills the rest of the shared context (06 §3, §5).
    expect(Object.keys(generation.capabilities["generate.inpaint"]?.params ?? {})).toEqual([
      "context",
      "gapBars",
      "overlapBars",
      "prompt",
      "seed",
      "tier",
      "n",
    ]);
    expect(generation.capabilities["generate.inpaint"]?.params).toMatchObject({
      context: { key: { tonic: "A", mode: "minor" } },
      gapBars: 4,
      overlapBars: 2,
      tier: "preview",
      n: 3,
    });
    expect(generation.capabilities["generate.transition"]?.params).toMatchObject({
      lengthBars: 2,
      tier: "preview",
    });
    expect(generation.capabilities["generate.extend"]?.params).toMatchObject({
      direction: "forward",
      bars: 8,
    });
  });

  it("is compact JSON with numbers, not prose", () => {
    const text = catalogueText();
    expect(text.length).toBeLessThan(4200);
    expect(text).not.toMatch(/label|description/);
  });
});
