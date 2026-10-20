import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadPlannerConfig, parseToml } from "../config.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Writes `text` to a temp config file and returns its path. */
function tempConfig(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "bragi-planner-"));
  tempDirs.push(dir);
  const path = join(dir, "planner.toml");
  writeFileSync(path, text);
  return path;
}

const VALID = `
# a comment
[models]
fast = "a/fast"
smart = "a/smart"
explain = "a/explain"

[limits]
maxTokens = 2048
timeoutMs = 30000
variantCount = 2
`;

describe("parseToml", () => {
  it("reads sections, strings, integers, floats and booleans", () => {
    expect(
      parseToml(`
title = "hello # not a comment"
ratio = 0.5
enabled = true

[models]
fast = "vendor/model"
`),
    ).toEqual({
      title: "hello # not a comment",
      ratio: 0.5,
      enabled: true,
      models: { fast: "vendor/model" },
    });
  });

  it.each([
    ["[broken", /malformed \[section\]/],
    ["key", /expected "key = value"/],
    ["key = [1, 2]", /unsupported value/],
    ['key = "open', /unterminated string/],
    ["bad key = 1", /invalid key/],
    ["a = 1\na = 2", /duplicate key/],
  ])("rejects %s", (text, pattern) => {
    expect(() => parseToml(text)).toThrow(pattern);
  });
});

describe("loadPlannerConfig", () => {
  it("reads the tiers and limits, with env overrides winning", () => {
    const config = loadPlannerConfig(
      { BRAGI_PLANNER_MODEL_SMART: "override/smart" },
      tempConfig(VALID),
    );
    expect(config).toEqual({
      models: { fast: "a/fast", smart: "override/smart", explain: "a/explain" },
      reasoning: { fast: "default", smart: "default", explain: "default" },
      maxTokens: 2048,
      timeoutMs: 30000,
      variantCount: 2,
    });
  });

  it("reads reasoning levels per tier, with the env override applying to every tier", () => {
    const withReasoning = `${VALID}\n[reasoning]\nfast = "off"\nsmart = "low"\n`;
    expect(loadPlannerConfig({}, tempConfig(withReasoning)).reasoning).toEqual({
      fast: "off",
      smart: "low",
      explain: "default",
    });
    expect(
      loadPlannerConfig({ BRAGI_PLANNER_REASONING: "high" }, tempConfig(withReasoning)).reasoning,
    ).toEqual({ fast: "high", smart: "high", explain: "high" });
    expect(() =>
      loadPlannerConfig({}, tempConfig(`${VALID}\n[reasoning]\nfast = "max"\n`)),
    ).toThrow(/reasoning\.fast/);
  });

  it("rejects a missing tier and an out-of-range variant count", () => {
    expect(() =>
      loadPlannerConfig(
        {},
        tempConfig(
          '[models]\nfast = "a/f"\n[limits]\nmaxTokens = 1\ntimeoutMs = 1\nvariantCount = 1\n',
        ),
      ),
    ).toThrow(/models\.smart/);
    expect(() =>
      loadPlannerConfig({}, tempConfig(VALID.replace("variantCount = 2", "variantCount = 4"))),
    ).toThrow(/variantCount/);
  });
});
