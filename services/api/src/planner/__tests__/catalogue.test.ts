import { describe, expect, it } from "vitest";

import { buildCatalogue, catalogueText } from "../catalogue.js";

describe("capability catalogue", () => {
  it("matches the generated schema and DSP catalogues", () => {
    expect(buildCatalogue()).toMatchSnapshot();
  });

  it("lists the v1 op kinds with the IDs they address", () => {
    const catalogue = buildCatalogue();
    const byOp = new Map(catalogue.ops.map((entry) => [entry.op, entry.ids]));
    expect(byOp.get("fx.add")).toEqual(["clipId", "trackId"]);
    expect(byOp.get("track.update")).toEqual(["trackId"]);
    expect(byOp.get("tempo.set")).toEqual([]);
    expect(catalogue.ops.map((entry) => entry.op)).toContain("section.update");
  });

  it("offers no generation capability in v1", () => {
    expect(buildCatalogue().generation).toEqual([]);
  });

  it("is compact JSON with numbers, not prose", () => {
    const text = catalogueText();
    expect(text.length).toBeLessThan(8000);
    expect(text).not.toMatch(/label|description/);
  });
});
