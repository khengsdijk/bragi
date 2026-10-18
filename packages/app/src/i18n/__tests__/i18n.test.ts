import { describe, expect, it } from "vitest";

import en from "../en.json" with { type: "json" };
import { t } from "../index.js";

describe("t", () => {
  it("looks strings up in en.json", () => {
    expect(t("app.name")).toBe("Bragi");
  });

  it("fills {placeholders}", () => {
    expect(t("song.notFound", { id: "prj_X" })).toContain("prj_X");
  });

  it("keeps labels short and calm (11 §2: ≤ 12 words, no exclamation marks)", () => {
    for (const [key, text] of Object.entries(en)) {
      expect(text, key).not.toMatch(/!/);
      if (key.endsWith(".label") || key.startsWith("nav.")) {
        expect(text.split(/\s+/).length, key).toBeLessThanOrEqual(12);
      }
    }
  });
});
