/**
 * A `appPage` fixture for the Song Canvas specs: a page from a context this file owns, with a
 * fixed viewport and device scale so screenshots and timings are comparable.
 *
 * WebKit needs a persistent context for the same reason as in `platform.spec.ts`: an ephemeral
 * WebKit session refuses OPFS to workers, which is where the app's database lives.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test as base, type Page } from "@playwright/test";

import { resetAppStorage } from "./reset-storage.js";

export const VIEWPORT = { width: 1280, height: 900 } as const;

interface Fixtures {
  readonly appPage: Page;
}

export const test = base.extend<Fixtures>({
  appPage: async ({ browser, playwright }, use, testInfo) => {
    const project = testInfo.project.name;
    const { baseURL } = testInfo.project.use;
    if (typeof baseURL !== "string") throw new Error(`project ${project} has no baseURL`);
    const contextOptions = {
      baseURL,
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      reducedMotion: "reduce" as const,
    };
    if (project.startsWith("webkit")) {
      const profile = mkdtempSync(join(tmpdir(), `bragi-webkit-${project}-`));
      const context = await playwright.webkit.launchPersistentContext(profile, contextOptions);
      const page = context.pages()[0] ?? (await context.newPage());
      try {
        await resetAppStorage(page);
        await use(page);
      } finally {
        await resetAppStorage(page).catch(() => undefined);
        await context.close();
        rmSync(profile, { recursive: true, force: true });
      }
      return;
    }
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    page.on("pageerror", (error) => console.log(`[pageerror] ${error.message}`));
    try {
      await resetAppStorage(page);
      await use(page);
    } finally {
      await resetAppStorage(page).catch(() => undefined);
      await context.close();
    }
  },
});

export { expect } from "@playwright/test";
