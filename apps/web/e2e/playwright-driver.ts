/** The Playwright driver: the same scenario against a real browser page. */
import type { Page } from "@playwright/test";

import type { ScenarioDriver } from "./scenario.js";

export function createPlaywrightDriver(page: Page, log: (line: string) => void): ScenarioDriver {
  const testId = (id: string) => page.getByTestId(id).first();

  return {
    async goto(route) {
      // The app routes on the URL hash (packages/app/src/app/router.tsx), so a
      // "deep link" is just the hash: no server rewrite is involved.
      await page.goto(`/#${route}`);
    },
    crossOriginIsolated: () => page.evaluate(() => globalThis.crossOriginIsolated),
    text: async (id) => ((await testId(id).textContent()) ?? "").trim(),
    attribute: (id, name) => testId(id).getAttribute(name),
    count: (id) => page.getByTestId(id).count(),
    async click(label) {
      // A named control: a link (project row, back) or a button (create). Testing
      // the same way a person navigates means a renamed control fails the test.
      const target = page
        .getByRole("link", { name: label, exact: true })
        .or(page.getByRole("button", { name: label, exact: true }));
      await target.first().click();
    },
    async fill(label, value) {
      await page.getByLabel(label, { exact: true }).fill(value);
    },
    log,
  };
}
