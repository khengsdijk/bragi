import { describe, expect, it } from "vitest";

import { contrastRows, coverageGaps, expand, THEMES, VISIONS } from "../audit.js";
import { ROLE_TOKEN_LIST, ROLE_TOKENS, SECTION_FAMILIES, SECTION_FAMILY_LIST } from "../mapping.js";
import { VISION_KEYS } from "../schema.js";
import { colourVariables, themeColours } from "../theme.js";
import { tokens } from "./tokens-fixture.js";

/**
 * Acceptance 1: every declared token pairing passes its WCAG ratio, in both themes, and no
 * colour token exists without a pairing that proves it.
 */
describe("token contrast", () => {
  const rows = contrastRows(tokens);

  it("declares pairings that match real tokens", () => {
    expect(rows.length).toBeGreaterThan(100);
  });

  it("passes every declared pairing", () => {
    const failures = rows.filter((row) => !row.ok);
    expect(
      failures.map((row) => `${row.theme} ${row.fg} on ${row.bg} = ${row.ratio} < ${row.required}`),
    ).toEqual([]);
  });

  it("checks text at 4.5:1 and graphics at 3:1", () => {
    expect(tokens.contrast.thresholds.text).toBe(4.5);
    expect(tokens.contrast.thresholds.graphic).toBe(3);
    const text = rows.filter((row) => row.required === 4.5);
    const graphics = rows.filter((row) => row.required === 3);
    expect(text.length).toBeGreaterThan(0);
    expect(graphics.length).toBeGreaterThan(0);
  });

  it("covers every colour token with a pairing or a decorative entry with a reason", () => {
    expect(coverageGaps(tokens)).toEqual([]);
    for (const entry of tokens.contrast.decorative) {
      expect(entry.reason.length).toBeGreaterThan(10);
    }
  });

  it("defines the same colour tokens in both themes", () => {
    const dark = [...themeColours(tokens, "dark").keys()].sort();
    const light = [...themeColours(tokens, "light").keys()].sort();
    expect(light).toEqual(dark);
  });

  it("checks role colours against every surface they are drawn on", () => {
    const names = [...themeColours(tokens, "dark").keys()];
    const roles = expand("--role-*", names);
    expect(roles).toEqual(ROLE_TOKEN_LIST.map((role) => `--role-${role}`).sort());
    for (const theme of THEMES) {
      const surfaces = ["--color-canvas", "--color-surface", "--color-surface-raised"];
      for (const role of roles) {
        for (const surface of surfaces) {
          const row = rows.find(
            (entry) => entry.theme === theme && entry.fg === role && entry.bg === surface,
          );
          expect(row, `${theme} ${role} on ${surface}`).toBeDefined();
          expect(row?.ok).toBe(true);
        }
      }
    }
  });

  it("checks every section label against every fill", () => {
    for (const theme of THEMES) {
      const fills = Object.keys(tokens.themes[theme].section.fill);
      for (const family of fills) {
        const row = rows.find(
          (entry) =>
            entry.theme === theme &&
            entry.fg === "--section-label" &&
            entry.bg === `--section-fill-${family}`,
        );
        expect(row, `${theme} section label on ${family}`).toBeDefined();
        expect(row?.ratio).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe("token structure", () => {
  it("gives every role a pattern, and no two roles the same pattern", () => {
    const patterns = Object.entries(tokens.rolePatterns);
    expect(patterns.map(([role]) => role).sort()).toEqual([...ROLE_TOKEN_LIST].sort());
    const ids = patterns.map(([, id]) => id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("maps every stem role and section kind onto a token that exists", () => {
    for (const theme of THEMES) {
      const names = colourVariables(tokens.themes[theme]);
      for (const token of new Set(Object.values(ROLE_TOKENS))) {
        expect(names.has(`--role-${token}`), `${theme} --role-${token}`).toBe(true);
      }
      for (const family of new Set(Object.values(SECTION_FAMILIES))) {
        expect(names.has(`--section-fill-${family}`), `${theme} --section-fill-${family}`).toBe(
          true,
        );
      }
      expect(names.has("--section-label")).toBe(true);
    }
  });

  it("uses exactly the section families the mapping table names", () => {
    expect(Object.keys(tokens.themes.dark.section.fill).sort()).toEqual(
      [...SECTION_FAMILY_LIST].sort(),
    );
  });

  it("declares a distinguishability threshold for every vision", () => {
    for (const group of [
      tokens.distinguishability.roles,
      tokens.distinguishability.sections,
      tokens.distinguishability.energyAdjacent,
    ]) {
      expect(Object.keys(group).sort()).toEqual([...VISION_KEYS].sort());
      for (const vision of VISIONS) {
        expect(group[vision]).toBeGreaterThan(0);
      }
    }
  });

  it("scales type and spacing off the documented base", () => {
    expect(tokens.type.baseRem).toBe(0.875); // 14 px at a 16 px root (11 §3)
    expect(tokens.type.ratio).toBe(1.2);
    expect(tokens.space.unitPx).toBe(4);
    expect(tokens.size.hitTargetPx).toBeGreaterThanOrEqual(24); // WCAG 2.5.8
  });
});
