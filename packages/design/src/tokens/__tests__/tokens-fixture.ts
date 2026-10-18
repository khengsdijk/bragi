import { readFileSync } from "node:fs";
import { join } from "node:path";

import { type DesignTokens, parseTokens } from "../schema.js";

/**
 * `tokens.json` as the checks see it, plus the package root.
 *
 * `import.meta.dirname` (rather than `new URL(..., import.meta.url)`) because Vitest transforms
 * test files in "web" mode, where `import.meta.url` is a served URL instead of a file path.
 */
export const packageRoot: string = join(import.meta.dirname, "../../..");

export const tokens: DesignTokens = parseTokens(
  JSON.parse(readFileSync(join(packageRoot, "tokens.json"), "utf8")),
);
