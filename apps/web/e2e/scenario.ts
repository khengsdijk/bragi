/**
 * The WP-0.5 acceptance scenario, written **once** and run by two drivers:
 *
 * - `playwright-driver.ts` — Chromium, Firefox and Playwright WebKit, against
 *   the dev server and against `vite preview` of the production build
 *   (`platform.spec.ts`).
 * - `dom-driver.ts` — the in-page driver the Tauri `selftest` feature evaluates
 *   inside the webview (`selftest-entry.ts`, `apps/desktop/scripts/selftest.mjs`),
 *   because WKWebView has no WebDriver and `tauri-driver` cannot reach it.
 *
 * The scenario speaks what a person does — go to a route, read what is on
 * screen, type into a labelled field, click a named button — never a selector
 * that only one driver can express. The copy it looks for comes from the app's
 * own `en.json` (`@bragi/app/i18n`), so a renamed label fails here instead of
 * silently passing against a stale literal.
 *
 * The project is deliberately *dummy*: a `projects` row plus one small blob in
 * the BlobCache. No song document is created — that needs `bragi-model` ops
 * (WP-0.3) — so this stays a platform test, not a model test.
 */
import { t } from "@bragi/app/i18n";

/** Everything the scenario needs from a host. */
export interface ScenarioDriver {
  /** Navigates to an app route, e.g. `/` or `/song/prj_…`, as a full navigation. */
  goto(route: string): Promise<void>;
  /** The page's `crossOriginIsolated`, false inside Tauri's webview. */
  crossOriginIsolated(): Promise<boolean>;
  /** Waits for the element with `data-testid`, then returns its trimmed text. */
  text(testId: string): Promise<string>;
  /** Waits for the element with `data-testid`, then returns one of its attributes. */
  attribute(testId: string, name: string): Promise<string | null>;
  /** How many elements with `data-testid` are in the document right now. */
  count(testId: string): Promise<number>;
  /** Clicks the link or button whose visible text is exactly `label`. */
  click(label: string): Promise<void>;
  /** Types `value` into the field labelled `label` (as a user would). */
  fill(label: string, value: string): Promise<void>;
  /** Adds a line to the transcript the desktop harness prints. */
  log(line: string): void;
}

/** The project the scenario creates. */
export const PROJECT_TITLE = "Dummy project";

/** `prj_` + a 26-character Crockford base32 ULID (02 §2.1). */
const PROJECT_ID = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;

/** A failed expectation, with the message the harness prints. */
export class ScenarioFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioFailure";
  }
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new ScenarioFailure(message);
}

function checkEqual(actual: unknown, expected: unknown, what: string): void {
  check(
    actual === expected,
    `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

/**
 * Creates a project through the UI and checks it comes straight back.
 *
 * Used on its own by the desktop harness's first launch (the second launch then
 * runs {@link assertProjectReadable} against a brand-new process), and followed
 * by a reload and {@link assertProjectReadable} in the browser.
 */
export async function createProjectFlow(driver: ScenarioDriver): Promise<void> {
  driver.log("create: opening the project list");
  await driver.goto("/");
  checkEqual(await driver.text("projects-empty"), t("projects.empty"), "the empty state");

  driver.log(`create: creating "${PROJECT_TITLE}"`);
  await driver.fill(t("projects.nameLabel"), PROJECT_TITLE);
  await driver.click(t("projects.create"));

  checkEqual(await driver.text("song-title"), PROJECT_TITLE, "the new project's title");
  const id = await driver.text("project-id");
  check(PROJECT_ID.test(id), `the project id: expected prj_<ULID>, got ${JSON.stringify(id)}`);
  checkEqual(
    await driver.attribute("card-status", "data-card-ok"),
    "true",
    "the stored card check",
  );
  driver.log(`create: stored ${id} and read it back, card verified`);
}

/**
 * The read-back half: the project list and the project's stored card must still
 * be there. On the web this runs after a reload of the same page; on the desktop
 * it runs in a **second process** over the same data directory, which also
 * proves the database and the blob cache were reopened from disk.
 */
export async function assertProjectReadable(driver: ScenarioDriver): Promise<void> {
  driver.log("read: opening the project list");
  await driver.goto("/");

  const row = await driver.text("project-row");
  checkEqual(row, PROJECT_TITLE, "the stored project's row");
  checkEqual(await driver.count("projects-empty"), 0, "the empty state after a reload");
  checkEqual(await driver.count("project-row"), 1, "the number of projects");

  await driver.click(PROJECT_TITLE);
  checkEqual(await driver.text("song-title"), PROJECT_TITLE, "the reopened project's title");
  const id = await driver.text("project-id");
  check(PROJECT_ID.test(id), `the project id: expected prj_<ULID>, got ${JSON.stringify(id)}`);
  checkEqual(
    await driver.attribute("card-status", "data-card-ok"),
    "true",
    "the stored card check",
  );
  driver.log(`read: ${id} and its stored card survived`);
}

/** Asserts the web build is cross-origin isolated (01 §3, acceptance criterion 2). */
export async function assertCrossOriginIsolated(driver: ScenarioDriver): Promise<void> {
  const isolated = await driver.crossOriginIsolated();
  check(isolated, "crossOriginIsolated: expected true, got false");
  driver.log("isolated: crossOriginIsolated is true");
}

/**
 * A deep link straight into `/song/:id`: the id comes from the URL, and the
 * project it names has to come out of the local database with its card intact.
 */
export async function assertSongRoute(driver: ScenarioDriver, id: string): Promise<void> {
  driver.log(`deep link: opening /song/${id}`);
  await driver.goto(`/song/${id}`);
  checkEqual(await driver.text("project-id"), id, "the id in the URL and on the page");
  checkEqual(await driver.text("song-title"), PROJECT_TITLE, "the deep-linked project's title");
  checkEqual(
    await driver.attribute("card-status", "data-card-ok"),
    "true",
    "the stored card check",
  );
}
