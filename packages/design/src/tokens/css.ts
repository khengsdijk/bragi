/**
 * Generate `tokens.css` from `tokens.json`.
 *
 * The generated file carries a "do not edit" header and is compared byte-for-byte with the
 * committed file by `css.test.ts`, so the two cannot drift.
 */

import type { DesignTokens } from "./schema.js";
import { baseVariables, themeVariables, type Variable } from "./theme.js";

export const GENERATED_HEADER = [
  "/**",
  " * GENERATED FILE — DO NOT EDIT.",
  " *",
  " * Source: packages/design/tokens.json",
  " * Regenerate: pnpm --filter @bragi/design tokens:gen",
  " * Tickets: WP-0.6, specs/11-ux-and-accessibility.md §3",
  " */",
].join("\n");

/** The full `tokens.css` text, trailing newline included. */
export function generateTokensCss(tokens: DesignTokens): string {
  const blocks: string[] = [
    block(":root", baseVariables(tokens)),
    block(':root,\n[data-theme="dark"]', [
      { name: "color-scheme", value: "dark" },
      ...themeVariables(tokens.themes.dark),
    ]),
    block('[data-theme="light"]', [
      { name: "color-scheme", value: "light" },
      ...themeVariables(tokens.themes.light),
    ]),
  ];

  return `${GENERATED_HEADER}\n\n${blocks.join("\n\n")}\n`;
}

function block(selector: string, variables: readonly Variable[]): string {
  const lines = variables.map((variable) => `  ${variable.name}: ${variable.value};`);
  return `${selector} {\n${lines.join("\n")}\n}`;
}
