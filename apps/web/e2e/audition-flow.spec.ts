/**
 * WP-2.5: auditioning on a real song, while it plays, against the live local stack.
 *
 *   upload -> play -> mute a stem (a second version) -> History: pick both versions, Compare ->
 *   the Audition bar opens, B/A switch the warm plans while playback keeps running -> axe ->
 *   Escape closes and returns to the original -> three candidates (made through the test hooks:
 *   the planner arrives with WP-2.6) -> 1–3 switch -> Accept: HEAD moves, siblings are discarded,
 *   playback continues.
 *
 * Whether the switches *sound* gapless is the engine's render-capture test (07 §10 check 4) and a
 * listening check; this spec proves the wiring and the engine staying healthy. Same gate as
 * `upload-flow.spec.ts` (`BRAGI_E2E_STACK=1`, single-user `dev:backend`).
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, test } from "./app-page.js";
import { withHooks } from "./song-helpers.js";
import {
  audioOutputRenders,
  historyView,
  hookDoc,
  openAnalysedSong,
  SKIP_REASON,
  STACK,
  seriousOrCritical,
  visible,
} from "./stack-helpers.js";

test.skip(!STACK, SKIP_REASON);

interface AuditionHooks {
  audition: {
    store: { getState(): { group: { kind: string } | null; selected: number; warm: number[] } };
    openCandidates(options: { group: string; prompt: string }): Promise<boolean>;
  };
  history: {
    addCandidates(batches: unknown[], group: string): Promise<{ id: string }[]>;
    store: { getState(): { head: string | null; commits: Map<string, { state: string }> } };
  };
  controller: {
    store: {
      getState(): {
        playing: boolean;
        positionSec: number;
        error: string | null;
        underruns: number;
        auditionSlot: number;
      };
    };
  };
}

const auditionView = (page: Page) =>
  withHooks(page, (hooks) => {
    const h = hooks as unknown as AuditionHooks;
    const state = h.audition.store.getState();
    const transport = h.controller.store.getState();
    return {
      kind: state.group?.kind ?? null,
      selected: state.selected,
      warm: [...state.warm].sort(),
      engineSlot: transport.auditionSlot,
      playing: transport.playing,
      positionSec: transport.positionSec,
      error: transport.error,
      underruns: transport.underruns,
    };
  });

test.describe("auditioning on a real song", () => {
  test.setTimeout(300_000);

  test("compare two versions and accept a candidate while playing", async ({
    appPage,
  }, testInfo) => {
    const errors: string[] = [];
    appPage.on("pageerror", (e) => errors.push(e.message));

    await appPage.goto("/#/");
    const audio = await audioOutputRenders(appPage);
    if (!audio) {
      testInfo.annotations.push({
        type: "audio",
        description: "this machine's audio output does not render: playback was not checked",
      });
      console.warn(`[audition] ${testInfo.project.name}: NO AUDIO OUTPUT, playback not checked`);
    }
    await openAnalysedSong(appPage, async () => {
      if (!audio) return;
      await expect
        .poll(() => withHooks(appPage, (h) => h.canvas?.stats().frames ?? 0).catch(() => 0))
        .toBeGreaterThan(0);
      await appPage.getByRole("button", { name: "Play" }).click();
      await expect
        .poll(
          () =>
            withHooks(appPage, (h) => {
              const state = h.controller.store.getState();
              return state.playing && state.positionSec > 0.5;
            }),
          { timeout: 60_000 },
        )
        .toBe(true);
    });

    // A second version: mute one stem from the accessible grid.
    const stem = visible(await hookDoc(appPage)).find((track) => track.role !== "full_mix");
    if (stem === undefined) throw new Error("no stem");
    const before = await historyView(appPage);
    await appPage.getByTestId(`grid-mute-${stem.id}`).focus();
    await appPage.keyboard.press("Enter");
    await expect.poll(async () => (await historyView(appPage)).count).toBe(before.count + 1);
    const original = await hookDoc(appPage);

    // History: pick HEAD and its parent with Space, then Compare.
    await appPage.getByRole("button", { name: "Version history" }).click();
    const tree = appPage.getByRole("tree", { name: "Version history" });
    await expect(tree).toBeVisible();
    const current = tree.locator('[role="treeitem"][aria-current="true"]');
    await current.focus();
    await appPage.keyboard.press(" ");
    await appPage.keyboard.press("ArrowDown");
    await appPage.keyboard.press(" ");
    await appPage.getByTestId("history-compare").click();

    const bar = appPage.getByRole("toolbar", { name: "Compare versions" });
    await expect(bar).toBeVisible();
    await expect.poll(async () => (await auditionView(appPage)).warm).toEqual([1, 2]);
    expect((await auditionView(appPage)).selected).toBe(1);
    expect(seriousOrCritical(await new AxeBuilder({ page: appPage }).analyze())).toEqual([]);

    const underrunsBefore = (await auditionView(appPage)).underruns;
    await appPage.locator("body").click({ position: { x: 1, y: 1 } });
    for (const key of ["b", "a", "b", "a", "b"]) {
      await appPage.keyboard.press(key);
      await appPage.waitForTimeout(250);
    }
    let view = await auditionView(appPage);
    expect(view.selected).toBe(2);
    expect(view.engineSlot).toBe(2);
    if (audio) expect(view.playing, "playback survives the switches").toBe(true);
    expect(view.error).toBeNull();
    await appPage.keyboard.press("Escape");
    await expect(bar).toBeHidden();
    view = await auditionView(appPage);
    expect(view.engineSlot).toBe(0);
    expect(await hookDoc(appPage), "a comparison commits nothing").toEqual(original);
    console.log(
      `[audition] ${testInfo.project.name}: compare B/A x5, underruns ${underrunsBefore} -> ${view.underruns}`,
    );

    // Three candidates from the test hooks (the planner arrives with WP-2.6).
    const candidates = await withHooks(
      appPage,
      async (hooks, trackId) => {
        const h = hooks as unknown as AuditionHooks;
        const now = new Date().toISOString();
        const make = (n: number, patch: Record<string, unknown>, label: string) => ({
          id: `bat_01JAUDITIONE2E00000000000${n}`,
          author: { kind: "ai", planId: "pln_01JAUDITIONE2E000000000000", model: "e2e" },
          label,
          ops: [{ op: "track.update", trackId, patch }],
          createdAt: now,
        });
        const added = await h.history.addCandidates(
          [
            make(1, { gainDb: -6 }, "Quieter"),
            make(2, { gainDb: 3 }, "Louder"),
            make(3, { pan: -0.5 }, "Panned left"),
          ],
          "grp_e2e_ideas",
        );
        await h.audition.openCandidates({ group: "grp_e2e_ideas", prompt: "Rebalance a stem" });
        return added.map((commit) => commit.id);
      },
      visible(original).find((track) => track.id !== stem.id && track.role !== "full_mix")?.id ??
        stem.id,
    );
    const ideas = appPage.getByRole("toolbar", { name: "Version ideas" });
    await expect(ideas).toBeVisible();
    await expect.poll(async () => (await auditionView(appPage)).warm).toEqual([1, 2, 3]);
    await expect(appPage.getByTestId("live-region")).toContainText("3 version ideas ready");
    // Accept was just enabled (idea 1 auto-selected): let its colour transition finish, or axe
    // measures an in-between fill (seen in WebKit).
    await appPage.evaluate(() =>
      Promise.all(document.getAnimations().map((animation) => animation.finished)),
    );
    expect(seriousOrCritical(await new AxeBuilder({ page: appPage }).analyze())).toEqual([]);

    await appPage.locator("body").click({ position: { x: 1, y: 1 } });
    for (const key of ["2", "3", "0", "2"]) {
      await appPage.keyboard.press(key);
      await appPage.waitForTimeout(250);
    }
    expect((await auditionView(appPage)).engineSlot).toBe(2);
    const start = await historyView(appPage);
    await ideas.getByRole("button", { name: "Accept" }).click();
    await expect(ideas).toBeHidden();
    await expect.poll(async () => (await historyView(appPage)).head).toBe(candidates[1]);
    const states = await withHooks(
      appPage,
      (hooks, ids) => {
        const commits = (hooks as unknown as AuditionHooks).history.store.getState().commits;
        return ids.map((id) => commits.get(id)?.state ?? null);
      },
      candidates,
    );
    expect(states).toEqual(["discarded", "committed", "discarded"]);
    expect((await historyView(appPage)).count).toBe(start.count);

    await appPage.waitForTimeout(1000);
    view = await auditionView(appPage);
    if (audio) expect(view.playing, "playback survives the accept").toBe(true);
    expect(view.error).toBeNull();
    expect(view.engineSlot).toBe(0);
    console.log(
      `[audition] ${testInfo.project.name}: accepted "Louder", underruns -> ${view.underruns}`,
    );
    expect(errors).toEqual([]);
  });
});
