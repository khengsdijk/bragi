#!/usr/bin/env node
/**
 * Guards the repository layout defined in specs/01-architecture.md §4.
 *
 * Every directory listed there must exist and carry a README.md saying what it
 * is and which work package fills it, so an agent picking up a WP always lands
 * in a described place.
 */
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Directories that must exist and contain a README.md. */
export const REQUIRED_DIRS = [
  "apps",
  "apps/web",
  "apps/desktop",
  "apps/desktop/src-tauri",
  "packages",
  "packages/app",
  "packages/design",
  "packages/render-canvas",
  "packages/render-universe",
  "packages/platform",
  "packages/model-wasm",
  "packages/schemas",
  "packages/api-client",
  "crates",
  "crates/bragi-model",
  "crates/bragi-dsp",
  "crates/bragi-engine",
  "crates/bragi-engine-wasm",
  "crates/bragi-engine-native",
  "services",
  "services/api",
  "services/workers",
  "services/workers/bragi_common",
  "services/workers/analysis",
  "services/workers/embed",
  "services/workers/generate",
  "infra",
  "infra/deploy",
  "fixtures",
  "fixtures/audio",
  "fixtures/projects",
  "fixtures/eval",
  "docs",
  "specs",
];

/**
 * @param {string} root repository root
 * @returns {string[]} one problem description per violation, empty when the layout is sound
 */
export function checkLayout(root) {
  const problems = [];
  for (const dir of REQUIRED_DIRS) {
    const abs = join(root, dir);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) {
      problems.push(`${dir}: missing directory`);
      continue;
    }
    if (!existsSync(join(abs, "README.md"))) {
      problems.push(`${dir}: missing README.md`);
    }
  }
  return problems;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const problems = checkLayout(root);
  if (problems.length > 0) {
    console.error("Repository layout does not match specs/01-architecture.md §4:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`Repository layout OK (${REQUIRED_DIRS.length} directories).`);
}
