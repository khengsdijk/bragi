/**
 * WP-2.1: the version tree in a real browser against the real local backend.
 *
 *   upload (analysis cached from earlier runs is fine) -> mute a stem -> undo restores the exact
 *   document -> redo -> open Version history -> go back to the first version -> edit there, which
 *   branches -> reload: the tree and the current version persist -> axe with the panel open.
 *
 * Same stack and gate as `upload-flow.spec.ts` (`BRAGI_E2E_STACK=1`, single-user `dev:backend`).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, test } from "./app-page.js";
import { type ProjectLike, withHooks } from "./song-helpers.js";

const STACK = process.env.BRAGI_E2E_STACK === "1";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FIXTURE = join(tmpdir(), "bragi-e2e", "bragi-fixture-4min.wav");

test.skip(
  !STACK,
  "needs the local backend (pnpm infra:up && pnpm dev:backend): set BRAGI_E2E_STACK=1 to run it",
);

/** The slice of the history store the test reads (`window.__bragi.history`). */
interface HistoryLike {
  store: {
    getState(): {
      commits: Map<string, { id: string; parent: string | null; label: string }>;
      children: Map<string, string[]>;
      head: string | null;
    };
  };
}

interface HistoryView {
  count: number;
  head: string | null;
  headLabel: string | null;
  root: string | null;
  rootChildren: number;
}

const historyView = (page: Page): Promise<HistoryView> =>
  withHooks(page, (hooks) => {
    const history = (hooks as unknown as { history: HistoryLike | null }).history;
    if (history === null) throw new Error("no history store");
    const state = history.store.getState();
    const commits = [...state.commits.values()];
    const root = commits.find((commit) => commit.parent === null)?.id ?? null;
    return {
      count: commits.length,
      head: state.head,
      headLabel: state.head === null ? null : (state.commits.get(state.head)?.label ?? null),
      root,
      rootChildren: root === null ? 0 : (state.children.get(root)?.length ?? 0),
    };
  });

type TrackLike = ProjectLike["tracks"][number] & { role?: string; hidden?: boolean };

/** Tracks the accessible grid shows a row for. */
const visible = (doc: ProjectLike | null): TrackLike[] =>
  ((doc?.tracks ?? []) as TrackLike[]).filter((track) => track.hidden !== true);

const hookDoc = (page: Page) =>
  withHooks(page, (hooks) => {
    const doc = hooks.store.store.getState().doc;
    return doc === null ? null : (JSON.parse(JSON.stringify(doc)) as ProjectLike);
  });

function seriousOrCritical(results: Awaited<ReturnType<AxeBuilder["analyze"]>>): string[] {
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

test.describe("version history on a real song", () => {
  test.setTimeout(300_000);

  test("undo, redo, go back, branch and reload", async ({ appPage }, testInfo) => {
    if (!existsSync(FIXTURE)) {
      mkdirSync(dirname(FIXTURE), { recursive: true });
      execFileSync("node", [join(ROOT, "scripts", "fixture-song.mjs"), FIXTURE], {
        stdio: "ignore",
      });
    }
    const errors: string[] = [];
    appPage.on("pageerror", (e) => errors.push(e.message));
    const mod = process.platform === "darwin" ? "Meta" : "Control";

    await appPage.goto("/#/");
    await expect(appPage.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await appPage.getByTestId("library-file").setInputFiles(FIXTURE);
    await expect(appPage.getByTestId("project-id")).toBeVisible({ timeout: 120_000 });
    const projectId = (await appPage.getByTestId("project-id").textContent()) ?? "";
    await appPage.evaluate((id) => {
      window.location.hash = `#/song/${id}?e2e=1`;
    }, projectId);
    await expect(appPage.getByTestId("song-workspace")).toBeVisible({ timeout: 60_000 });

    // Let the analysis finish: stems in the document and no new system commit for 5 s.
    await expect
      .poll(async () => ((await hookDoc(appPage))?.tracks.length ?? 0) > 2, { timeout: 240_000 })
      .toBe(true);
    let settled = -1;
    await expect
      .poll(
        async () => {
          const { count } = await historyView(appPage);
          const stable = count === settled;
          settled = count;
          return stable;
        },
        { timeout: 120_000, intervals: [5000] },
      )
      .toBe(true);
    const start = await historyView(appPage);
    console.log(`[history] ${testInfo.project.name}: ${start.count} commits after analysis`);
    expect(start.count).toBeGreaterThanOrEqual(2);

    // Mute a stem from the accessible grid: one commit on top of HEAD.
    const before = await hookDoc(appPage);
    const stem = visible(before).find((track) => track.role !== "full_mix");
    if (before === null || stem === undefined) throw new Error("no stem");
    const mute = appPage.getByTestId(`grid-mute-${stem.id}`);
    await mute.focus();
    await appPage.keyboard.press("Enter");
    await expect(mute).toHaveAttribute("aria-pressed", "true");
    // The commit lands once its snapshot is stored, just after the button updates.
    await expect.poll(async () => (await historyView(appPage)).count).toBe(start.count + 1);
    const muted = await hookDoc(appPage);
    const afterMute = await historyView(appPage);

    // Undo (07 §4 keyboard): the exact previous document; redo brings the mute back.
    await appPage.locator("body").click({ position: { x: 1, y: 1 } });
    await appPage.keyboard.press(`${mod}+z`);
    await expect.poll(() => hookDoc(appPage)).toEqual(before);
    await appPage.keyboard.press(`${mod}+Shift+z`);
    await expect.poll(() => hookDoc(appPage)).toEqual(muted);
    expect((await historyView(appPage)).head).toBe(afterMute.head);

    // Version history: the tree shows every version and marks the current one.
    await appPage.getByRole("button", { name: "Version history" }).click();
    const tree = appPage.getByRole("tree", { name: "Version history" });
    await expect(tree).toBeVisible();
    await expect(tree.locator('[role="treeitem"][aria-current="true"]')).toHaveCount(1);
    expect(seriousOrCritical(await new AxeBuilder({ page: appPage }).analyze())).toEqual([]);

    // Go back to the first version with the keyboard. It is the upload's first analysis step, so
    // it sits inside the collapsed "Analysis" row (07 §7), the last row: expand it, then take the
    // oldest step.
    const current = tree.locator('[role="treeitem"][aria-current="true"]');
    await current.focus();
    await appPage.keyboard.press("End");
    await expect(appPage.locator('[role="treeitem"]:focus')).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await appPage.keyboard.press("ArrowRight");
    await expect(appPage.locator('[role="treeitem"]:focus')).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await appPage.keyboard.press("End");
    await expect(appPage.locator('[role="treeitem"]:focus')).not.toHaveAttribute(
      "aria-expanded",
      /.*/,
    );
    await appPage.keyboard.press("Enter");
    await expect.poll(async () => (await historyView(appPage)).head).toBe(start.root);
    await expect
      .poll(async () => (await hookDoc(appPage))?.tracks.length ?? 0)
      .toBeLessThan(before.tracks.length);

    // An edit there starts a branch: the first version now has two children.
    const rootDoc = await hookDoc(appPage);
    const track = visible(rootDoc)[0];
    if (track === undefined) throw new Error("no track in the first version");
    await appPage.getByTestId(`grid-mute-${track.id}`).focus();
    await appPage.keyboard.press("Enter");
    await expect.poll(async () => (await historyView(appPage)).rootChildren).toBe(2);
    const branched = await historyView(appPage);
    expect(branched.count).toBe(afterMute.count + 1);

    // Reload: the tree and the current version come back from the local database.
    await appPage.reload();
    await expect(appPage.getByTestId("song-workspace")).toBeVisible({ timeout: 60_000 });
    await expect.poll(async () => (await historyView(appPage)).count).toBe(branched.count);
    // Nothing is replayed onto the reopened version: the count holds once the page settles.
    await appPage.waitForTimeout(3000);
    const reloaded = await historyView(appPage);
    expect(reloaded.count).toBe(branched.count);
    expect(reloaded.head).toBe(branched.head);
    expect(reloaded.rootChildren).toBe(2);
    await expect
      .poll(async () => (await hookDoc(appPage))?.tracks.find((t) => t.id === track.id)?.mute)
      .toBe(true);

    await appPage.getByRole("button", { name: "Version history" }).click();
    await expect(appPage.getByRole("tree", { name: "Version history" })).toBeVisible();
    expect(seriousOrCritical(await new AxeBuilder({ page: appPage }).analyze())).toEqual([]);
    expect(errors).toEqual([]);
  });
});
