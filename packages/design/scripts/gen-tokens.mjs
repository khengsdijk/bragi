#!/usr/bin/env node
/**
 * Generate `tokens.css` from `tokens.json`, or print the token audit.
 *
 *   pnpm --filter @bragi/design tokens:gen       # write tokens.css
 *   pnpm --filter @bragi/design tokens:report    # print the contrast and ΔE00 tables
 *
 * Reads the built package (`dist/`), so `tsc -b` runs first — see the package scripts.
 */
import { readFileSync, writeFileSync } from "node:fs";

import {
  contrastRows,
  coverageGaps,
  distinguishabilityRows,
  THEMES,
} from "../dist/tokens/audit.js";
import { formatHex, parseColor } from "../dist/tokens/color.js";
import { generateTokensCss } from "../dist/tokens/css.js";
import { formatOklch } from "../dist/tokens/oklch.js";
import { parseTokens } from "../dist/tokens/schema.js";
import { colourVariables } from "../dist/tokens/theme.js";

const tokensUrl = new URL("../tokens.json", import.meta.url);
const cssUrl = new URL("../tokens.css", import.meta.url);

const tokens = parseTokens(JSON.parse(readFileSync(tokensUrl, "utf8")));
const report = process.argv.includes("--report");

if (report) {
  printReport();
} else {
  const css = generateTokensCss(tokens);
  writeFileSync(cssUrl, css);
  console.log(`tokens.css written (${css.length} bytes) from tokens.json`);
}

function printReport() {
  const rows = contrastRows(tokens);
  const failures = rows.filter((row) => !row.ok);

  console.log(`contrast: ${rows.length} pairings, ${failures.length} failing`);
  for (const theme of THEMES) {
    console.log(`\n  ${theme}`);
    for (const row of rows.filter((entry) => entry.theme === theme)) {
      console.log(
        `    ${row.ok ? "ok  " : "FAIL"} ${row.ratio.toFixed(2).padStart(6)} >= ${String(row.required).padEnd(4)} ${row.fg} on ${row.bg}`,
      );
    }
  }

  const gaps = coverageGaps(tokens);
  console.log(`\ncoverage: ${gaps.length} colour token(s) without a pairing`);
  for (const gap of gaps) console.log(`  - ${gap.theme} ${gap.token}`);

  console.log("\ndistinguishability (minimum ΔE00 across the group, per vision)");
  for (const row of distinguishabilityRows(tokens)) {
    console.log(
      `  ${row.ok ? "ok  " : "FAIL"} ${row.theme.padEnd(5)} ${row.group.padEnd(8)} ${row.vision.padEnd(13)} ${row.min.toFixed(2).padStart(6)} >= ${String(row.threshold).padEnd(4)} closest: ${row.pair.join(" vs ")}`,
    );
  }

  for (const theme of THEMES) {
    console.log(`\n${theme} palette (hex → oklch)`);
    for (const [name, value] of colourVariables(tokens.themes[theme])) {
      const hex = formatHex(parseColor(value));
      console.log(`  ${name.padEnd(28)} ${hex}  ${formatOklch(parseColor(hex))}`);
    }
  }
}
