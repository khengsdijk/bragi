#!/usr/bin/env node
/**
 * Guards the repository layout against specs/01-architecture.md §4.
 *
 * The list of directories is *derived from the spec*, not restated here: the
 * fenced tree under "## 4. Repository layout" is parsed on every run. Adding a
 * directory to that tree therefore makes `pnpm lint:layout` fail until the
 * directory exists, which is what "the specs are the source of truth"
 * (specs/13-agent-guide.md §1) means in practice.
 *
 * Each required directory must also carry a README.md saying what it is and
 * which work package fills it, so an agent picking up a WP always lands in a
 * described place.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Directories required by other specs, which the 01 §4 tree does not list.
 *
 * - `docs` holds one implementation plan per work package (13 §2).
 * - the `fixtures/*` subdirectories are named in 13 §6.
 */
export const EXTRA_DIRS = ["docs", "fixtures/audio", "fixtures/projects", "fixtures/eval"];

const SECTION_HEADING = "## 4. Repository layout";

/**
 * Extracts the directory paths from the repository tree in 01 §4.
 *
 * Entries that are not directories (files, and notes such as
 * `(loads packages/app)`) are ignored; only names ending in `/` count.
 *
 * @param {string} markdown contents of specs/01-architecture.md
 * @returns {string[]} directory paths relative to the repository root, parents first
 * @throws {Error} if the section or its fenced tree cannot be found
 */
export function parseArchitectureTree(markdown) {
  const sectionStart = markdown.indexOf(SECTION_HEADING);
  if (sectionStart === -1) {
    throw new Error(`specs/01-architecture.md: "${SECTION_HEADING}" not found`);
  }
  const section = markdown.slice(sectionStart);
  const fence = /^```\w*\n([\s\S]*?)^```/m.exec(section);
  if (!fence?.[1]) {
    throw new Error(`specs/01-architecture.md §4: no fenced tree found after the heading`);
  }

  const dirs = [];
  /** @type {string[]} path of the enclosing directory per depth, index 0 = repository root */
  const stack = [""];
  for (const rawLine of fence[1].split("\n")) {
    const line = rawLine.split(" #")[0]?.trimEnd() ?? "";
    const marker = /[├└]─ /.exec(line);
    if (!marker || marker.index % 3 !== 0) continue; // the `bragi/` root line, or a blank

    const depth = marker.index / 3 + 1;
    const name = line.slice(marker.index + marker[0].length);
    if (!name.endsWith("/")) continue; // a file, or a prose note

    const parent = stack[depth - 1];
    if (parent === undefined) continue; // malformed indentation: ignore rather than guess
    const path = parent === "" ? name.slice(0, -1) : `${parent}/${name.slice(0, -1)}`;
    stack[depth] = path;
    stack.length = depth + 1;
    dirs.push(path);
  }
  return dirs;
}

/**
 * The directories this repository must have: the 01 §4 tree plus {@link EXTRA_DIRS}.
 *
 * @param {string} root repository root
 * @returns {string[]}
 */
export function requiredDirs(root) {
  const spec = readFileSync(join(root, "specs", "01-architecture.md"), "utf8");
  return [...new Set([...parseArchitectureTree(spec), ...EXTRA_DIRS])];
}

/**
 * @param {string} root repository root
 * @param {string[]} dirs directories that must exist and contain a README.md
 * @returns {string[]} one problem description per violation, empty when the layout is sound
 */
export function checkLayout(root, dirs) {
  const problems = [];
  for (const dir of dirs) {
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
  const dirs = requiredDirs(root);
  const problems = checkLayout(root, dirs);
  if (problems.length > 0) {
    console.error("Repository layout does not match specs/01-architecture.md §4:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(`Repository layout OK (${dirs.length} directories, derived from 01 §4).`);
}
