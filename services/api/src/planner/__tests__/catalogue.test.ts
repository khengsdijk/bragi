import { describe, expect, it } from "vitest";

import { buildCatalogue, catalogueText } from "../catalogue.js";

describe("capability catalogue", () => {
  it("matches the generated DSP catalogues", () => {
    expect(buildCatalogue()).toMatchSnapshot();
  });

  it("lists fx ranges and macros, and does not repeat the op shapes", () => {
    const catalogue = buildCatalogue();
    expect(catalogue.fx.filter?.cutoffHz).toEqual({ min: 20, max: 20000, default: 20000 });
    expect(Object.keys(catalogue.macros).length).toBeGreaterThan(0);
    expect(catalogueText()).not.toContain('"ops"');
  });

  it("offers no generation capability in v1", () => {
    expect(buildCatalogue().generation).toEqual([]);
  });

  it("is compact JSON with numbers, not prose", () => {
    const text = catalogueText();
    expect(text.length).toBeLessThan(4000);
    expect(text).not.toMatch(/label|description/);
  });
});
