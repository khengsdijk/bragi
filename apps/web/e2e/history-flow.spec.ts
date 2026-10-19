/**
 * WP-2.1: the version tree in a real browser against the real local backend.
 *
 *   upload (analysis cached from earlier runs is fine) -> mute a stem -> undo restores the exact
 *   document -> redo -> open Version history -> go back to the first version -> edit there, which
 *   branches -> reload: the tree and the current version persist -> axe with the panel open.
 *
 * Same stack and gate as `upload-flow.spec.ts` (`BRAGI_E2E_STACK=1`, single-user `dev:backend`).
 */
import AxeBuilder from "@axe-core/playwright";

import { expect, test } from "./app-page.js";
import {
  historyView,
  hookDoc,
  openAnalysedSong,
  SKIP_REASON,
  STACK,
  seriousOrCritical,
  visible,
} from "./stack-helpers.js";

test.skip(!STACK, SKIP_REASON);

test.describe("version history on a real song", () => {
  test.setTimeout(300_000);

  test("undo, redo, go back, branch and reload", async ({ appPage }, testInfo) => {
    const errors: string[] = [];
    appPage.on("pageerror", (e) => errors.push(e.message));
    const mod = process.platform === "darwin" ? "Meta" : "Control";

    await openAnalysedSong(appPage);
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
