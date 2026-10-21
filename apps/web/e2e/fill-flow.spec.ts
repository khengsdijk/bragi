/**
 * WP-2.8: erase two bars on two stems, Fill gap with AI, accept, undo (07 §4.8; 09 §4.3).
 *
 *   analysed song -> playback -> Paint + Remove over two bars on two stems -> the ✨ Fill gap chip
 *   appears next to the gap -> click: both sides render, the ideas stream into the Audition bar ->
 *   Accept -> the generated fill is separated into the gap on the song's stem tracks -> undo restores
 *   the erased document exactly -> axe with the chip visible.
 *
 * The generation worker runs the **fake backend** (`BRAGI_GENERATION_BACKEND=fake`), so no model and
 * no GPU are needed. Same gate and stack as `extend-flow.spec.ts` (`BRAGI_E2E_STACK=1`, single-user
 * `dev:backend`).
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, test } from "./app-page.js";
import { ribbonPoint, withHooks } from "./song-helpers.js";
import {
  audioOutputRenders,
  barLengths,
  historyView,
  hookDoc,
  openAnalysedSong,
  SKIP_REASON,
  STACK,
  seriousOrCritical,
  stemTracks,
  type TrackLike,
} from "./stack-helpers.js";

test.skip(!STACK, SKIP_REASON);

/** A mouse stroke along one ribbon, in small steps, so the preview refreshes several times. */
async function stroke(page: Page, trackId: string, fromSec: number, toSec: number): Promise<void> {
  const from = await ribbonPoint(page, trackId, fromSec);
  const to = await ribbonPoint(page, trackId, toSec);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let step = 1; step <= 12; step += 1) {
    await page.mouse.move(from.x + ((to.x - from.x) * step) / 12, from.y);
    await page.waitForTimeout(60);
  }
  await page.mouse.up();
}

interface FillOffer {
  readonly region: { startTick: number; endTick: number };
  readonly label: string;
}

const fillOffer = (page: Page): Promise<FillOffer | null> =>
  withHooks(page, (hooks) => hooks.offers?.store.getState().fill ?? null);

test.describe("filling an erased gap with AI", () => {
  test.setTimeout(600_000);

  test("erase two bars, fill the gap, accept, undo (fake backend)", async ({
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
    }
    await openAnalysedSong(appPage);
    const before = await hookDoc(appPage);
    if (before === null) throw new Error("no document after analysis");
    const stems = stemTracks(before);
    if (stems.length < 2) throw new Error("the song has fewer than two stem tracks");
    const [first, second] = stems as [TrackLike, TrackLike];
    const bars = barLengths(before);
    // Two bars in the middle of the song, where both stems have material.
    const startBar = Math.max(
      4,
      Math.floor(
        (before.arrangement.sections.reduce((sum, s) => sum + s.lengthTicks, 0) / bars.ticks) * 0.4,
      ),
    );
    const fromSec = startBar * bars.sec - 0.3;
    const toSec = (startBar + 2) * bars.sec + 0.3;

    await withHooks(appPage, (hooks) => {
      hooks.canvas?.fit();
      hooks.canvas?.renderNow();
    });
    if (audio) {
      await appPage.getByRole("button", { name: "Play" }).click();
      await expect
        .poll(() => withHooks(appPage, (hooks) => hooks.controller.store.getState().playing), {
          timeout: 60_000,
        })
        .toBe(true);
    }

    // Erase two bars on each stem: Paint on, Remove, one stroke each (07 §4.4).
    await appPage.getByTestId("brush-paint-toggle").click();
    await appPage.locator('input[type="radio"][value="remove"]').check({ force: true });
    for (const stem of [first, second]) {
      const count = (await historyView(appPage)).count;
      await stroke(appPage, stem.id, fromSec, toSec);
      await expect.poll(async () => (await historyView(appPage)).count).toBe(count + 1);
    }
    const erased = await hookDoc(appPage);
    if (erased === null) throw new Error("no document after erase");
    const offer = await fillOffer(appPage);
    if (offer === null) throw new Error("no Fill gap offer after erasing");
    // The offer is the erased region as stroked (a little past both bar lines); the inpaint
    // request snaps it inward to whole bars.
    expect(offer.region.startTick).toBeLessThanOrEqual(startBar * bars.ticks);
    expect(offer.region.endTick).toBeGreaterThanOrEqual((startBar + 2) * bars.ticks);
    expect(offer.label).toContain(second.name);
    console.log(
      `[fill] ${testInfo.project.name}: erased "${offer.label}" on ${first.name} + ${second.name}`,
    );

    // The chip is a named button next to the gap; axe runs with it visible.
    const chip = appPage.getByRole("button", { name: "✨ Fill gap" });
    await expect(chip).toBeVisible();
    expect(seriousOrCritical(await new AxeBuilder({ page: appPage }).analyze())).toEqual([]);
    const erasedHistory = await historyView(appPage);
    await chip.click();

    const bar = appPage.getByRole("toolbar", { name: "Version ideas" });
    await expect(bar).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(
        () =>
          withHooks(appPage, (hooks) => {
            const state = hooks.audition?.store.getState();
            return state?.group?.kind ?? null;
          }),
        { timeout: 120_000 },
      )
      .toBe("candidates");
    // The job asks for three ideas; on this song the fake fill does not always pass every gate,
    // and 09 §6 returns what passed (or its best with a warning), so wait for the job to finish
    // and work with the ideas that arrived.
    await expect
      .poll(() => withHooks(appPage, (hooks) => hooks.fill?.store.getState().phase ?? "none"), {
        timeout: 300_000,
      })
      .toBe("preview");
    const ideas = await withHooks(appPage, (hooks) =>
      [...(hooks.audition?.store.getState().warm ?? [])].sort(),
    );
    expect(ideas.length, "at least one idea").toBeGreaterThan(0);
    console.log(`[fill] ${testInfo.project.name}: ${ideas.length} idea(s) warm`);

    const underrunsBefore = await withHooks(
      appPage,
      (hooks) => hooks.controller.store.getState().underruns,
    );
    await appPage.locator("body").click({ position: { x: 1, y: 1 } });
    for (const key of [...ideas.slice(1), ideas[0]].map(String)) {
      await appPage.keyboard.press(key);
      await appPage.waitForTimeout(200);
    }
    if (audio) {
      expect(
        await withHooks(appPage, (hooks) => hooks.controller.store.getState().playing),
        "playback survives the idea switches",
      ).toBe(true);
    }
    await bar.getByRole("button", { name: "Accept" }).click();
    await expect(bar).toBeHidden();
    await expect
      .poll(() => withHooks(appPage, (hooks) => hooks.fill?.store.getState().phase ?? "none"), {
        timeout: 30_000,
      })
      .toBe("accepted");

    // The gap's clips are on the two erased stems' tracks, and the mix-only generated lane is gone
    // (09 §9 check 2). Poll while the fill's own separation lands.
    const gapFilled = async () => {
      const doc = await hookDoc(appPage);
      if (doc === null) return null;
      let tick = 0;
      let section:
        | NonNullable<Awaited<ReturnType<typeof hookDoc>>>["arrangement"]["sections"][number]
        | undefined;
      for (const candidate of doc.arrangement.sections) {
        if (tick + candidate.lengthTicks > offer.region.startTick && tick < offer.region.endTick) {
          section = candidate;
          break;
        }
        tick += candidate.lengthTicks;
      }
      if (section === undefined) return null;
      const roles = new Map(doc.tracks.map((track) => [track.id, track.role]));
      const lanes = Object.entries(section.lanes ?? {}).filter(([, lane]) => lane.clips.length > 0);
      return {
        generated: lanes.some(([trackId]) => roles.get(trackId) === "generated"),
        onStems: [first.id, second.id].filter(
          (trackId) => (section?.lanes?.[trackId]?.clips.length ?? 0) > 0,
        ).length,
      };
    };
    await expect
      .poll(gapFilled, { timeout: 240_000, intervals: [1_000] })
      .toEqual({ generated: false, onStems: 2 });
    console.log(`[fill] ${testInfo.project.name}: gap clips mapped onto both stem tracks`);

    // Undo returns to the erased document exactly (the fill and its analysis are separate commits).
    await appPage.locator("body").click({ position: { x: 1, y: 1 } });
    for (let step = 0; step < 12; step += 1) {
      const head = await historyView(appPage).then((history) => history.head);
      if (head === erasedHistory.head) break;
      await appPage.keyboard.press(`${mod}+z`);
      await appPage.waitForTimeout(400);
    }
    await expect
      .poll(() => historyView(appPage).then((history) => history.head))
      .toBe(erasedHistory.head);
    await expect.poll(() => hookDoc(appPage), { timeout: 30_000 }).toEqual(erased);

    expect(
      await withHooks(appPage, (hooks) => hooks.controller.store.getState().error),
      "the engine stayed healthy",
    ).toBeNull();
    console.log(`[fill] ${testInfo.project.name}: accepted a fill, underruns ${underrunsBefore}`);
    expect(errors).toEqual([]);
  });
});
