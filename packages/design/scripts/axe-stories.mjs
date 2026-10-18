#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
/**
 * Acceptance 3: axe passes on all stories, in both themes.
 *
 * Serves the static Storybook build, opens every story in the dark and the light theme, runs
 * axe-core with the WCAG 2.0–2.2 A/AA tags and fails on any serious or critical violation.
 *
 *   pnpm --filter @bragi/design test:stories
 */
import { createServer } from "node:http";
import { extname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { AxeBuilder } from "@axe-core/playwright";
import { chromium } from "playwright";

const STATIC_DIR = resolve(fileURLToPath(new URL("../storybook-static", import.meta.url)));
const THEMES = ["dark", "light"];
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const requested = decodeURIComponent(url.pathname);
  const candidates = [join(STATIC_DIR, normalize(requested))];
  if (requested.endsWith("/"))
    candidates.push(join(STATIC_DIR, normalize(requested), "index.html"));

  for (const candidate of candidates) {
    if (!isInside(STATIC_DIR, candidate)) break;
    try {
      const info = await stat(candidate);
      if (!info.isFile()) continue;
      response.writeHead(200, {
        "content-type": MIME[extname(candidate)] ?? "application/octet-stream",
      });
      response.end(await readFile(candidate));
      return;
    } catch {
      // try the next candidate
    }
  }

  response.writeHead(404, { "content-type": "text/plain" });
  response.end("not found");
});

function isInside(root, candidate) {
  const path = relative(root, candidate);
  return path !== "" && !path.startsWith(`..${sep}`) && path !== ".." && !path.startsWith(sep);
}

const index = JSON.parse(await readFile(join(STATIC_DIR, "index.json"), "utf8"));
const stories = Object.values(index.entries ?? {}).filter((entry) => entry.type === "story");
if (stories.length === 0) {
  console.error("axe-stories: no stories found in storybook-static/index.json");
  process.exit(1);
}

await new Promise((done) => server.listen(0, "127.0.0.1", done));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

const violations = [];
const incomplete = new Map();
let scans = 0;

for (const story of stories) {
  for (const theme of THEMES) {
    const url = `${base}/iframe.html?id=${encodeURIComponent(story.id)}&globals=theme:${theme}`;
    await page.goto(url, { waitUntil: "load" });
    try {
      await page.waitForFunction(
        () => {
          const root = document.getElementById("storybook-root");
          if ((root?.childElementCount ?? 0) > 0) return true;
          return (
            document.querySelectorAll(
              '[data-radix-popper-content-wrapper], [role="dialog"], [role="status"], [role="tooltip"], [role="menu"]',
            ).length > 0
          );
        },
        { timeout: 5000 },
      );
    } catch {
      violations.push({
        story: story.id,
        theme,
        rule: "story-rendered",
        impact: "critical",
        help: "story rendered nothing",
      });
      continue;
    }
    await page.evaluate(() => document.fonts.ready);
    // Settle the page: colour transitions would otherwise be sampled mid-flight, which reports
    // contrast ratios that no user ever sees.
    await page.addStyleTag({
      content:
        "*, *::before, *::after { transition: none !important; animation: none !important; }",
    });
    await page.waitForTimeout(50);

    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    scans += 1;

    for (const violation of results.violations) {
      if (violation.impact !== "serious" && violation.impact !== "critical") continue;
      violations.push({
        story: story.id,
        theme,
        rule: violation.id,
        impact: violation.impact,
        help: violation.help,
        nodes: violation.nodes.map((node) => ({
          target: node.target.join(" "),
          html: node.html.slice(0, 200),
          summary: node.failureSummary,
        })),
      });
    }

    for (const entry of results.incomplete) {
      incomplete.set(entry.id, (incomplete.get(entry.id) ?? 0) + 1);
    }
  }
}

await context.close();
await browser.close();
server.close();

console.log(
  `axe-stories: ${scans} scans (${stories.length} stories × ${THEMES.length} themes), tags ${TAGS.join(", ")}`,
);
if (incomplete.size > 0) {
  console.log("  needs review (axe could not decide):");
  for (const [rule, count] of [...incomplete.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(count).padStart(3)} × ${rule}`);
  }
}

if (violations.length === 0) {
  console.log("  0 serious or critical violations");
} else {
  console.error(`  ${violations.length} serious or critical violations:`);
  for (const violation of violations) {
    console.error(
      `    ${violation.story} [${violation.theme}] ${violation.rule} (${violation.impact}): ${violation.help}`,
    );
    for (const node of violation.nodes ?? []) {
      console.error(`      ${node.target}\n        ${node.html}`);
      if (node.summary) console.error(`        ${node.summary.split("\n").join("\n        ")}`);
    }
  }
  process.exit(1);
}
