/**
 * Removes the app's local storage for the current origin.
 *
 * "A fresh browser context" is *not* "a fresh app data directory". WebKit keeps
 * website data in `~/Library/WebKit/<browser id>/WebsiteData` no matter which
 * profile directory Playwright is handed, so a database written by an earlier
 * run would still be there — and OPFS is exactly where the app's SQLite database
 * and blob cache live (01 §3). Chromium and Firefox fresh contexts are already
 * empty; running the same reset in every engine keeps the three comparable.
 *
 * `/favicon.svg` is a same-origin document that is *not* the app: the app opens
 * its database and holds an OPFS lock as soon as it boots, so its storage has to
 * be removed while it is not running.
 */
import type { Page } from "@playwright/test";

export async function resetAppStorage(page: Page): Promise<void> {
  await page.goto("/favicon.svg");
  await page.evaluate(async () => {
    localStorage.clear();
    sessionStorage.clear();

    const root = await navigator.storage.getDirectory();
    for await (const name of root.keys()) {
      await root.removeEntry(name, { recursive: true });
    }

    if ("caches" in globalThis) {
      for (const key of await caches.keys()) await caches.delete(key);
    }
    for (const database of (await indexedDB.databases?.()) ?? []) {
      if (database.name !== undefined) indexedDB.deleteDatabase(database.name);
    }
  });
}
