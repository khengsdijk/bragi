/** Loads the versioned planner prompts from `prompts/*.md` (06 §4 flush left). */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The system prompt version; bump it when the wording changes materially. */
export const SYSTEM_PROMPT_VERSION = "1";

/** The plan system prompt, read once. */
let cachedSystem: string | undefined;

/** The explain addendum, read once. */
let cachedExplain: string | undefined;

/** The system prompt for a plan request (06 §4). */
export function systemPrompt(): string {
  cachedSystem ??= readPrompt("system.md");
  return cachedSystem;
}

/** The extra instruction for "Explain this" (06 §8). */
export function explainPrompt(): string {
  cachedExplain ??= readPrompt("explain.md");
  return cachedExplain;
}

/**
 * Reads a prompt file next to this module, falling back to the source tree because `tsc` does
 * not copy `.md` files into `dist/`.
 */
function readPrompt(file: string): string {
  const candidates = [
    new URL(`./prompts/${file}`, import.meta.url),
    new URL(`../../src/planner/prompts/${file}`, import.meta.url),
  ];
  for (const candidate of candidates) {
    const path = fileURLToPath(candidate);
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  throw new Error(`planner prompt ${file} is missing from the package`);
}
