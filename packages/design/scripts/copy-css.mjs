#!/usr/bin/env node
/**
 * Copy the CSS that sits next to the TypeScript into `dist/`, so the built JavaScript can
 * resolve its CSS-module and stylesheet imports. `tokens.css` itself is generated at the
 * package root by `tokens:gen`; this only handles `src/**` (plus `base.css` and `fonts.css`,
 * which stay at the root for the exports map).
 */
import { cpSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceRoot = join(packageRoot, "src");
const outputRoot = join(packageRoot, "dist");

let copied = 0;
for (const file of walk(sourceRoot)) {
  if (!file.endsWith(".css")) continue;
  const destination = join(outputRoot, relative(sourceRoot, file));
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(file, destination);
  copied += 1;
}

console.log(`copy-css: ${copied} stylesheet(s) → dist/`);

function* walk(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}
