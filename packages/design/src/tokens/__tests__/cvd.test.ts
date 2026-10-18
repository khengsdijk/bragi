import { describe, expect, it } from "vitest";

import { distinguishabilityRows } from "../audit.js";
import { parseColor, type Rgba } from "../color.js";
import { SIMULATIONS, simulate } from "../cvd.js";
import { rgbToOklch } from "../oklch.js";
import { cvdJsonPath, cvdSnapshotJson, cvdSvg, cvdSvgPath } from "../snapshots.js";
import { tokens } from "./tokens-fixture.js";

/**
 * Acceptance 2: colour-blind simulation snapshots exist, are current, and the palettes stay
 * distinguishable under simulation.
 */

describe("Machado simulation", () => {
  it("leaves neutral greys where they are (the matrices are row-normalised)", () => {
    for (const grey of ["#000000", "#5a5a5a", "#808080", "#e0e0e0", "#ffffff"]) {
      for (const simulation of SIMULATIONS) {
        const simulated = simulate(parseColor(grey), simulation);
        expect(Math.abs(simulated.r - parseColor(grey).r)).toBeLessThanOrEqual(1);
        expect(Math.abs(simulated.b - parseColor(grey).b)).toBeLessThanOrEqual(1);
      }
    }
  });

  it("collapses the red/green hue difference under protanopia and deuteranopia", () => {
    const red = parseColor("#ff0000");
    const green = parseColor("#008000");
    const hueGap = (a: Rgba, b: Rgba): number => {
      const gap = Math.abs(rgbToOklch(a).h - rgbToOklch(b).h);
      return Math.min(gap, 360 - gap);
    };

    const normal = hueGap(red, green);
    expect(normal).toBeGreaterThan(90);
    expect(hueGap(simulate(red, "protanopia"), simulate(green, "protanopia"))).toBeLessThan(
      normal / 2,
    );
    expect(hueGap(simulate(red, "deuteranopia"), simulate(green, "deuteranopia"))).toBeLessThan(
      normal / 2,
    );
    // Tritanopia barely touches the red/green axis, so the two stay far apart in hue.
    expect(hueGap(simulate(red, "tritanopia"), simulate(green, "tritanopia"))).toBeGreaterThan(90);
  });

  it("keeps every token colour inside the sRGB cube after simulation", () => {
    for (const theme of ["dark", "light"] as const) {
      const entry = tokens.themes[theme];
      const colours = [
        ...Object.values(entry.role),
        ...Object.values(entry.section.fill),
        ...entry.energy,
      ];
      for (const colour of colours) {
        for (const simulation of SIMULATIONS) {
          const result = simulate(parseColor(colour), simulation);
          for (const channel of [result.r, result.g, result.b]) {
            expect(channel).toBeGreaterThanOrEqual(0);
            expect(channel).toBeLessThanOrEqual(255);
          }
        }
      }
    }
  });
});

describe("colour-blind snapshots", () => {
  it("keeps the dark-theme JSON snapshot current", async () => {
    await expect(cvdSnapshotJson(tokens, "dark")).toMatchFileSnapshot(
      `../../../${cvdJsonPath("dark")}`,
    );
  });

  it("keeps the light-theme JSON snapshot current", async () => {
    await expect(cvdSnapshotJson(tokens, "light")).toMatchFileSnapshot(
      `../../../${cvdJsonPath("light")}`,
    );
  });

  it("keeps the dark-theme swatch sheet current", async () => {
    await expect(cvdSvg(tokens, "dark")).toMatchFileSnapshot(`../../../${cvdSvgPath("dark")}`);
  });

  it("keeps the light-theme swatch sheet current", async () => {
    await expect(cvdSvg(tokens, "light")).toMatchFileSnapshot(`../../../${cvdSvgPath("light")}`);
  });
});

describe("palette distinguishability", () => {
  const rows = distinguishabilityRows(tokens);

  it("measures every group in every vision", () => {
    expect(rows).toHaveLength(2 * 3 * 4);
  });

  it("keeps every pair above its declared ΔE00 threshold", () => {
    const failures = rows.filter((row) => !row.ok);
    expect(
      failures.map(
        (row) =>
          `${row.theme} ${row.group} ${row.vision}: ${row.min} < ${row.threshold} (${row.pair.join(" vs ")})`,
      ),
    ).toEqual([]);
  });

  it("keeps a perceptual floor under every vision, on top of the declared budgets", () => {
    for (const row of rows) {
      expect(row.min, `${row.theme} ${row.group} ${row.vision}`).toBeGreaterThanOrEqual(
        row.vision === "normal" ? 12 : 4,
      );
    }
  });
});
