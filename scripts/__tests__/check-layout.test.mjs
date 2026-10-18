import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { checkLayout, EXTRA_DIRS, parseArchitectureTree, requiredDirs } from "../check-layout.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

describe("parseArchitectureTree", () => {
  it("turns the fenced tree under §4 into directory paths", () => {
    const markdown = [
      "## 3. Something else",
      "```",
      "not/ the tree",
      "```",
      "",
      "## 4. Repository layout",
      "",
      "```",
      "bragi/",
      "├─ apps/",
      "│  ├─ web/                    # Vite entry",
      "│  └─ desktop/                # Tauri 2 app",
      "│     ├─ src-tauri/           # Rust side",
      "│     └─ (loads packages/app)",
      "├─ infra/",
      "│  ├─ docker-compose.yml      # postgres, minio",
      "│  └─ deploy/                 # IaC",
      "└─ specs/                     # These documents",
      "```",
      "",
      "## 5. Next",
    ].join("\n");

    expect(parseArchitectureTree(markdown)).toEqual([
      "apps",
      "apps/web",
      "apps/desktop",
      "apps/desktop/src-tauri",
      "infra",
      "infra/deploy",
      "specs",
    ]);
  });

  it("refuses to guess when the section or its tree is missing", () => {
    expect(() => parseArchitectureTree("# No section here\n")).toThrow(/Repository layout/);
    expect(() => parseArchitectureTree("## 4. Repository layout\n\nno fence\n")).toThrow(/fenced/);
  });
});

describe("requiredDirs", () => {
  it("derives the list from specs/01-architecture.md §4 rather than restating it", () => {
    const dirs = requiredDirs(repoRoot);
    const spec = readFileSync(join(repoRoot, "specs", "01-architecture.md"), "utf8");
    // Every path in the spec's tree is required...
    for (const dir of parseArchitectureTree(spec)) {
      expect(dirs).toContain(dir);
    }
    // ...plus the few directories other specs require.
    for (const dir of EXTRA_DIRS) expect(dirs).toContain(dir);
    expect(dirs).toHaveLength(new Set(dirs).size);
  });

  it("still contains the landmarks the repository is built around", () => {
    const dirs = requiredDirs(repoRoot);
    for (const dir of [
      "apps/web",
      "apps/desktop/src-tauri",
      "packages/app",
      "packages/model-wasm",
      "packages/schemas",
      "crates/bragi-model",
      "crates/bragi-engine-native",
      "services/api",
      "services/workers/bragi_common",
      "services/workers/generate",
      "infra/deploy",
      "fixtures",
      "specs",
      "docs",
    ]) {
      expect(dirs).toContain(dir);
    }
    // A parser that silently matched nothing would pass every `toContain`
    // above if the list were empty, so pin the order of magnitude too.
    expect(dirs.length).toBeGreaterThanOrEqual(30);
  });
});

describe("checkLayout", () => {
  it("reports every required directory as missing in an empty tree", () => {
    const empty = mkdtempSync(join(tmpdir(), "bragi-layout-"));
    const problems = checkLayout(empty, ["apps", "crates/bragi-model"]);
    expect(problems).toEqual(["apps: missing directory", "crates/bragi-model: missing directory"]);
  });

  it("reports a directory that exists but has no README", () => {
    const root = mkdtempSync(join(tmpdir(), "bragi-layout-"));
    mkdirSync(join(root, "specs"), { recursive: true });
    const problems = checkLayout(root, ["specs"]);
    expect(problems).toEqual(["specs: missing README.md"]);
  });

  it("accepts a directory with a README", () => {
    const root = mkdtempSync(join(tmpdir(), "bragi-layout-"));
    mkdirSync(join(root, "specs"), { recursive: true });
    writeFileSync(join(root, "specs", "README.md"), "# specs\n");
    expect(checkLayout(root, ["specs"])).toEqual([]);
  });

  it("finds no problems in this repository", () => {
    expect(checkLayout(repoRoot, requiredDirs(repoRoot))).toEqual([]);
  });
});
