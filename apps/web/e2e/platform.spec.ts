/**
 * The web half of WP-0.5's acceptance: "the same e2e test (create a dummy
 * project, store it, reload, read it back) passes in Chromium, Firefox, Safari
 * (web) and ... `crossOriginIsolated === true`".
 *
 * One test, run in six projects: three engines × {dev server, production
 * preview}. The steps are the shared scenario in `scenario.ts`; only the driver
 * is browser-specific.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test as base, type Page } from "@playwright/test";

import { createPlaywrightDriver } from "./playwright-driver.js";
import { resetAppStorage } from "./reset-storage.js";
import {
  assertCrossOriginIsolated,
  assertProjectReadable,
  assertSongRoute,
  createProjectFlow,
} from "./scenario.js";

interface Fixtures {
  readonly appPage: Page;
}

/**
 * A page from a context this file owns.
 *
 * Why not the built-in `page` fixture: Playwright's WebKit contexts are
 * *ephemeral* (a private-browsing-like session), and WebKit refuses OPFS to
 * workers in an ephemeral session — `navigator.storage.getDirectory()` throws
 * `UnknownError` inside the worker, which is where sqlite-wasm and the OPFS blob
 * cache live (01 §3). A normal Safari profile is persistent, so the WebKit runs
 * use `launchPersistentContext`, the closest stand-in for "a person opens the
 * app". Chromium and Firefox get an ordinary fresh context.
 *
 * Neither kind is a *clean app data directory* — see `reset-storage.ts` — so the
 * fixture clears the app's own storage before the scenario starts.
 *
 * The cost is that the runner's own trace/video artefacts are tied to its
 * context fixture, so this suite reports through the driver's transcript on the
 * console instead.
 */
const test = base.extend<Fixtures>({
  appPage: async ({ browser, playwright }, use, testInfo) => {
    const project = testInfo.project.name;
    const { baseURL } = testInfo.project.use;
    if (typeof baseURL !== "string") {
      throw new Error(`project ${project} has no baseURL`);
    }
    const contextOptions = { baseURL, viewport: { width: 1280, height: 800 } };

    if (project.startsWith("webkit")) {
      const profile = mkdtempSync(join(tmpdir(), `bragi-webkit-${project}-`));
      const context = await playwright.webkit.launchPersistentContext(profile, contextOptions);
      const page = context.pages()[0] ?? (await context.newPage());
      try {
        await resetAppStorage(page);
        await use(page);
      } finally {
        // Leave no database behind — see reset-storage.ts: WebKit's website data
        // belongs to the browser installation, not to the profile directory.
        await resetAppStorage(page).catch(() => undefined);
        await context.close();
        rmSync(profile, { recursive: true, force: true });
      }
      return;
    }

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    try {
      await resetAppStorage(page);
      await use(page);
    } finally {
      await resetAppStorage(page).catch(() => undefined);
      await context.close();
    }
  },
});

test("creates a project, survives a reload, and reads it back", async ({ appPage }) => {
  const driver = createPlaywrightDriver(appPage, (line) => console.log(`[e2e] ${line}`));

  // A cross-origin isolated page is what sqlite-wasm and SharedArrayBuffer need
  // (01 §3); assert it before touching storage so a header regression is
  // reported as itself rather than as a storage failure.
  await driver.goto("/");
  await assertCrossOriginIsolated(driver);

  await createProjectFlow(driver);
  const id = await driver.text("project-id");

  // The reload: the page comes back from the server and the project has to come
  // back out of OPFS.
  await appPage.reload();
  await assertProjectReadable(driver);
  await assertCrossOriginIsolated(driver);

  // And a fresh deep link straight into the song route, with the id from the URL.
  await assertSongRoute(driver, id);

  // Back to the list: still exactly one project, so nothing was duplicated by
  // the reload (assertProjectReadable also opens it again).
  await assertProjectReadable(driver);
});
