import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { checkLayout, REQUIRED_DIRS } from "../check-layout.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

describe("REQUIRED_DIRS", () => {
  it("covers every directory named in specs/01-architecture.md §4", () => {
    for (const dir of [
      "apps/web",
      "apps/desktop/src-tauri",
      "packages/app",
      "packages/design",
      "packages/render-canvas",
      "packages/render-universe",
      "packages/platform",
      "packages/model-wasm",
      "packages/schemas",
      "packages/api-client",
      "crates/bragi-model",
      "crates/bragi-dsp",
      "crates/bragi-engine",
      "crates/bragi-engine-wasm",
      "crates/bragi-engine-native",
      "services/api",
      "services/workers/bragi_common",
      "services/workers/analysis",
      "services/workers/embed",
      "services/workers/generate",
      "infra/deploy",
      "fixtures",
      "specs",
    ]) {
      expect(REQUIRED_DIRS).toContain(dir);
    }
  });
});

describe("checkLayout", () => {
  it("reports every required directory as missing in an empty tree", () => {
    const empty = mkdtempSync(join(tmpdir(), "bragi-layout-"));
    const problems = checkLayout(empty);
    expect(problems).toHaveLength(REQUIRED_DIRS.length);
    expect(problems.every((p) => p.includes("missing directory"))).toBe(true);
  });

  it("reports a directory that exists but has no README", () => {
    const root = mkdtempSync(join(tmpdir(), "bragi-layout-"));
    mkdirSync(join(root, "specs"), { recursive: true });
    const problems = checkLayout(root);
    expect(problems).toContain("specs: missing README.md");
    expect(problems).not.toContain("specs: missing directory");
  });

  it("accepts a directory with a README", () => {
    const root = mkdtempSync(join(tmpdir(), "bragi-layout-"));
    mkdirSync(join(root, "specs"), { recursive: true });
    writeFileSync(join(root, "specs", "README.md"), "# specs\n");
    expect(checkLayout(root).filter((p) => p.startsWith("specs:"))).toEqual([]);
  });

  it("finds no problems in this repository", () => {
    expect(checkLayout(repoRoot)).toEqual([]);
  });
});
