/**
 * 13 §1 rule 9: `packages/app` is platform-agnostic. It must not import
 * `@tauri-apps/*`, nor reach into a specific platform adapter — it gets a
 * `Platform` object from its host. Biome enforces the same rule at lint time
 * (biome.json override); this test keeps it enforced even if lint is skipped.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FORBIDDEN = [/@tauri-apps\//, /@bragi\/platform\/(web|tauri|auto)\b/, /@sqlite\.org\//];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|js|jsx|mts)$/.test(entry.name) ? [path] : [];
  });
}

describe("packages/app boundaries", () => {
  it("declares no platform-specific dependency", () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    expect(deps.filter((dep) => FORBIDDEN.some((rule) => rule.test(dep)))).toEqual([]);
  });

  it("imports nothing platform-specific from its sources", () => {
    const offenders = sourceFiles(join(PACKAGE_ROOT, "src"))
      .filter((file) => !file.includes("__tests__"))
      .flatMap((file) =>
        [...readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)]
          .map((match) => match[1] ?? "")
          .filter((specifier) => FORBIDDEN.some((rule) => rule.test(specifier)))
          .map((specifier) => `${file}: ${specifier}`),
      );
    expect(offenders).toEqual([]);
  });
});
