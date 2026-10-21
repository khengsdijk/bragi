/**
 * WP-2.7: extend a real song with AI on the live local stack, with the generation worker on the
 * **fake backend** (`BRAGI_GENERATION_BACKEND=fake`, so no model and no GPU are needed).
 *
 *   analysed song -> the extend handle at the song end -> "Make longer…", 8 bars, a prompt ->
 *   the ideas stream into the Audition bar while playback runs -> switch ideas -> Accept: the
 *   candidate is committed, a new section appears after the last one with the generated clip ->
 *   undo restores the exact document -> axe with the popover open.
 *
 * Same gate and stack as `upload-flow.spec.ts` (`BRAGI_E2E_STACK=1`, single-user `dev:backend`,
 * `BRAGI_GENERATION_BACKEND=fake`).
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
} from "./stack-helpers.js";

test.skip(!STACK, SKIP_REASON);

interface AuditionView {
  readonly group: { id: string; kind: string } | null;
  readonly selected: number;
  readonly warm: number[];
  readonly engineSlot: number;
  readonly playing: boolean;
  readonly error: string | null;
}

const auditionView = (page: Page): Promise<AuditionView> =>
  withHooks(page, (hooks) => {
    const audition = hooks.audition?.store.getState();
    const transport = hooks.controller.store.getState();
    return {
      group: audition?.group ?? null,
      selected: audition?.selected ?? 0,
      warm: [...(audition?.warm ?? [])].sort(),
      engineSlot: transport.auditionSlot,
      playing: transport.playing,
      error: transport.error,
    };
  });

const extendPhase = (page: Page): Promise<string> =>
  withHooks(page, (hooks) => hooks.extend?.store.getState().phase ?? "none");

test.describe("extending the song with AI", () => {
  test.setTimeout(600_000);

  test("stream ideas, switch while playing and accept one (fake backend)", async ({
    appPage,
  }, testInfo) => {
    const errors: string[] = [];
    appPage.on("pageerror", (event) => errors.push(event.message));
    const mod = process.platform === "darwin" ? "Meta" : "Control";

    await appPage.goto("/#/");
    const audio = await audioOutputRenders(appPage);
    if (!audio) {
      testInfo.annotations.push({
        type: "audio",
        description: "this machine's audio output does not render: playback was not checked",
      });
      console.warn(`[extend] ${testInfo.project.name}: NO AUDIO OUTPUT, playback not checked`);
    }

    await openAnalysedSong(appPage);
    const before = await hookDoc(appPage);
    if (before === null) throw new Error("no document after analysis");
    const startHistory = await historyView(appPage);

    // Start playback first, so the idea switches happen on a running transport (07 §6).
    if (audio) {
      await appPage.getByRole("button", { name: "Play" }).click();
      await expect
        .poll(() => withHooks(appPage, (hooks) => hooks.controller.store.getState().playing), {
          timeout: 60_000,
        })
        .toBe(true);
    }

    // The handle at the song end opens the labelled popover; axe runs with it open.
    await appPage.getByRole("button", { name: "Make the song longer with AI" }).click();
    const dialog = appPage.getByRole("dialog", { name: "Make the song longer with AI" });
    await expect(dialog).toBeVisible();
    expect(
      seriousOrCritical(await new AxeBuilder({ page: appPage }).analyze()),
      "axe with the extend popover open",
    ).toEqual([]);

    await dialog.getByRole("radio", { name: "8 bars" }).check({ force: true });
    await dialog.getByRole("textbox", { name: "What should happen next?" }).fill("dreamy outro");
    const generate = dialog.getByRole("button", { name: "Generate" });
    // A server without a generation worker disables this and says why (09 §5).
    await expect(generate).toBeEnabled();
    await generate.click();
    await expect(dialog).toBeHidden();

    // The bar opens before the first idea and fills as the partials stream in (09 §5).
    const bar = appPage.getByRole("toolbar", { name: "Version ideas" });
    await expect(bar).toBeVisible();
    await expect
      .poll(() => auditionView(appPage).then((view) => view.group?.kind ?? null), {
        timeout: 120_000,
      })
      .toBe("candidates");
    const queue = appPage.getByTestId("audition-queue");
    if (await queue.isVisible()) {
      console.log(`[extend] ${testInfo.project.name}: queue badge "${await queue.innerText()}"`);
    }

    await expect
      .poll(() => auditionView(appPage).then((view) => view.warm), { timeout: 300_000 })
      .toEqual([1, 2, 3]);
    let view = await auditionView(appPage);
    expect(view.warm).toEqual([1, 2, 3]);
    expect(await appPage.getByTestId("live-region").innerText()).toMatch(/idea|version idea/i);
    console.log(`[extend] ${testInfo.project.name}: 3 ideas streaming, selected ${view.selected}`);

    // Switch between ideas while the transport keeps running (07 §10 check 4 is the engine's).
    await appPage.locator("body").click({ position: { x: 1, y: 1 } });
    const underrunsBefore = await withHooks(
      appPage,
      (hooks) => hooks.controller.store.getState().underruns,
    );
    for (const key of ["2", "3", "1", "2"]) {
      await appPage.keyboard.press(key);
      await appPage.waitForTimeout(250);
    }
    view = await auditionView(appPage);
    expect(view.engineSlot).toBe(2);
    if (audio) expect(view.playing, "playback survives the idea switches").toBe(true);
    expect(view.error).toBeNull();

    // Accept: HEAD moves to the idea, the section appears and the job's other ideas are discarded.
    const candidateIds = await withHooks(appPage, (hooks) =>
      [...(hooks.history?.store.getState().commits.values() ?? [])]
        .filter((commit) => commit.candidateGroup !== undefined && commit.state === "candidate")
        .map((commit) => commit.id),
    );
    expect(candidateIds.length).toBe(3);
    await bar.getByRole("button", { name: "Accept" }).click();
    await expect(bar).toBeHidden();
    await expect
      .poll(() => historyView(appPage).then((history) => history.head), { timeout: 30_000 })
      .not.toBe(startHistory.head);
    expect(await extendPhase(appPage)).toBe("accepted");

    await expect
      .poll(async () => (await hookDoc(appPage))?.arrangement.sections.length ?? 0, {
        timeout: 120_000,
      })
      .toBe(before.arrangement.sections.length + 1);

    const accepted = await hookDoc(appPage);
    if (accepted === null) throw new Error("no document after accept");
    const generated = accepted.sources?.find((source) => source.kind === "generated");
    expect(generated, "the accepted candidate adds a generated source").toBeDefined();
    const last = accepted.arrangement.sections.at(-1);
    const clips = Object.values(last?.lanes ?? {}).flatMap((lane) => lane.clips);
    expect(
      clips.some((clip) => clip.asset === generated?.workingAsset),
      "the new section plays the generated audio",
    ).toBe(true);
    expect(last?.kind).toBe("outro");

    const states = await withHooks(
      appPage,
      (hooks, ids) => {
        const commits = hooks.history?.store.getState().commits;
        return ids.map((id) => commits?.get(id)?.state ?? null);
      },
      candidateIds,
    );
    expect(states.filter((state) => state === "committed")).toHaveLength(1);
    expect(states.filter((state) => state === "discarded")).toHaveLength(2);
    // The accepted idea is the one extend entry on the version tree.
    const extendStates = await withHooks(appPage, (hooks) =>
      [...(hooks.history?.store.getState().commits.values() ?? [])]
        .filter((commit) => commit.label === "Extend: 8 bars")
        .map((commit) => commit.state),
    );
    expect(extendStates).toEqual(["committed"]);
    const endHistory = await historyView(appPage);
    console.log(
      `[extend] ${testInfo.project.name}: accepted one idea, ${startHistory.count} -> ${endHistory.count} commits, underruns ${underrunsBefore}`,
    );

    // Undo: back to the commit the job started from. The generated audio's own analysis may land
    // on top first, so undo until HEAD is that commit again (each undo moves one commit, 02 §7).
    await appPage.locator("body").click({ position: { x: 1, y: 1 } });
    for (let step = 0; step < 12; step += 1) {
      const head = await historyView(appPage).then((history) => history.head);
      if (head === startHistory.head) break;
      await appPage.keyboard.press(`${mod}+z`);
      await appPage.waitForTimeout(400);
    }
    await expect
      .poll(() => historyView(appPage).then((history) => history.head))
      .toBe(startHistory.head);
    await expect.poll(() => hookDoc(appPage), { timeout: 30_000 }).toEqual(before);

    expect(errors).toEqual([]);
  });
});
