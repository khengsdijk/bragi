import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { GENERATED_HEADER, generateTokensCss } from "../css.js";
import { baseVariables, themeVariables } from "../theme.js";
import { packageRoot, tokens } from "./tokens-fixture.js";

const committed = readFileSync(join(packageRoot, "tokens.css"), "utf8");

describe("tokens.css", () => {
  it("is exactly what tokens.json generates", () => {
    expect(committed).toBe(generateTokensCss(tokens));
  });

  it("opens with the do-not-edit header", () => {
    expect(committed.startsWith(GENERATED_HEADER)).toBe(true);
    expect(committed).toContain("DO NOT EDIT");
    expect(committed).toContain("pnpm --filter @bragi/design tokens:gen");
  });

  it("carries a dark default and a light override", () => {
    expect(committed).toContain(':root,\n[data-theme="dark"] {');
    expect(committed).toContain('[data-theme="light"] {');
    expect(committed).toContain("color-scheme: dark;");
    expect(committed).toContain("color-scheme: light;");
  });

  it("declares every variable the theme layer produces, exactly once per block", () => {
    for (const variable of baseVariables(tokens)) {
      const occurrences = committed.split(`${variable.name}: `).length - 1;
      expect(occurrences, variable.name).toBe(1);
    }
    for (const theme of ["dark", "light"] as const) {
      for (const variable of themeVariables(tokens.themes[theme])) {
        expect(committed, `${theme} ${variable.name}`).toContain(
          `${variable.name}: ${variable.value};`,
        );
      }
    }
  });

  it("has balanced braces", () => {
    const open = committed.split("{").length - 1;
    const close = committed.split("}").length - 1;
    expect(open).toBe(close);
    expect(open).toBe(3);
  });
});
