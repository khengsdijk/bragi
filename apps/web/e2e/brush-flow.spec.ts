/**
 * WP-2.4: painting brushes on a real song, while it plays, against the live local stack.
 *
 *   upload -> play -> Paint on, Space -> a mouse stroke across a stem (07 §10 check 3): the
 *   document does not change during the stroke, the preview carries the brush, one commit on
 *   release with automation ramps of at least 50 ms, playback keeps running -> undo restores the
 *   exact document -> Remove on a stem commits one `region.clear` -> undo -> axe with the palette.
 *
 * Whether the stroke *sounds* clean (no tail cuts while painting) is the owner's listening check
 * (`docs/wp/2.4-MANUAL_CHECKS.md`); this spec checks that the engine never hears a revert during
 * the stroke and stays healthy. Same gate as `section-flow.spec.ts` (`BRAGI_E2E_STACK=1`,
 * single-user `dev:backend`).
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, test } from "./app-page.js";
import { ribbonPoint, withHooks } from "./song-helpers.js";
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

/** The slice of the Song Store this spec reads beyond the shared `Hooks` type. */
interface StoreLike {
  store: {
    getState(): {
      doc: {
        tracks: { fx: unknown[] }[];
        arrangement: {
          sections: {
            id: string;
            lanes: Record<string, { automation?: Automation[] }>;
          }[];
        };
      } | null;
      preview: { tracks: { fx: unknown[] }[] } | null;
    };
  };
  handle(): number | null;
  model: {
    sectionSpans(handle: number): string;
    ticksToSeconds(handle: number, ticks: bigint): number;
  };
}

interface Automation {
  readonly target: string;
  readonly points: readonly { readonly tick: number; readonly value: number }[];
}

/** The shortest ramp between two differing points of the stroke's automation, in seconds. */
async function shortestRampSec(page: Page, trackId: string): Promise<number> {
  return withHooks(
    page,
    (hooks, id) => {
      const songStore = hooks.store as unknown as StoreLike;
      const doc = songStore.store.getState().doc;
      const handle = songStore.handle();
      if (doc === null || handle === null) return Number.NaN;
      const spans = JSON.parse(songStore.model.sectionSpans(handle)) as {
        sectionId: string;
        startTick: number;
      }[];
      let shortest = Number.POSITIVE_INFINITY;
      for (const section of doc.arrangement.sections) {
        const start = spans.find((span) => span.sectionId === section.id)?.startTick ?? 0;
        const lane = section.lanes[id];
        for (const entry of lane?.automation ?? []) {
          for (let index = 1; index < entry.points.length; index += 1) {
            const left = entry.points[index - 1];
            const right = entry.points[index];
            if (left === undefined || right === undefined || left.value === right.value) continue;
            const seconds =
              songStore.model.ticksToSeconds(handle, BigInt(start + right.tick)) -
              songStore.model.ticksToSeconds(handle, BigInt(start + left.tick));
            shortest = Math.min(shortest, seconds);
          }
        }
      }
      return shortest;
    },
    trackId,
  );
}

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
}

test.describe("painting brushes on a real song", () => {
  test.setTimeout(300_000);

  test("Space while playing, one commit, undo, Remove, axe", async ({ appPage }, testInfo) => {
    const errors: string[] = [];
    appPage.on("pageerror", (e) => errors.push(e.message));
    const mod = process.platform === "darwin" ? "Meta" : "Control";

    await appPage.goto("/#/");
    const audio = await audioOutputRenders(appPage);
    if (!audio) {
      testInfo.annotations.push({
        type: "audio",
        description: "this machine's audio output does not render: playback was not checked",
      });
      console.warn(`[brushes] ${testInfo.project.name}: NO AUDIO OUTPUT, playback not checked`);
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
    await withHooks(appPage, (h) => {
      h.canvas?.fit();
      h.canvas?.renderNow();
    });

    const before = await hookDoc(appPage);
    if (before === null) throw new Error("no document");
    const stems = visible(before).filter((track) => track.role !== "full_mix");
    const stem = stems.find((track) => track.role === "drums") ?? stems[0];
    if (stem === undefined) throw new Error("the song has no visible stem");
    console.log(`[brushes] ${testInfo.project.name}: painting on ${stem.name} (${stem.id})`);

    const paint = appPage.getByTestId("brush-paint-toggle");
    await paint.click();
    await expect(paint).toHaveAttribute("aria-pressed", "true");
    await appPage.locator('input[type="radio"][value="space"]').check({ force: true });

    // Space across the stem while playing: the document holds still, the preview carries it.
    const start = await historyView(appPage);
    const underrunsBefore = await withHooks(
      appPage,
      (h) => h.controller.store.getState().underruns,
    );
    await stroke(appPage, stem.id, 10, 16);
    const during = await withHooks(appPage, (h) => {
      const state = (h.store as unknown as StoreLike).store.getState();
      return {
        docFx: state.doc?.tracks.map((track) => track.fx.length) ?? [],
        previewFx: state.preview?.tracks.map((track) => track.fx.length) ?? null,
      };
    });
    const fxBefore = (before as unknown as { tracks: { fx: unknown[] }[] }).tracks.map(
      (track) => track.fx.length,
    );
    expect(during.docFx, "the document does not change during a stroke").toEqual(fxBefore);
    expect(during.previewFx, "the preview carries the brush").not.toEqual(during.docFx);
    if (audio) {
      expect(await withHooks(appPage, (h) => h.controller.store.getState().playing)).toBe(true);
    }
    await appPage.mouse.up();

    await expect.poll(async () => (await historyView(appPage)).count).toBe(start.count + 1);
    const commit = await withHooks(appPage, (h) => h.store.store.getState().lastCommit);
    expect(commit?.batch.label).toMatch(/^Space on /);
    expect((await historyView(appPage)).headLabel).toBe(commit?.batch.label);
    await expect(appPage.getByTestId("live-region")).toHaveText(commit?.batch.label ?? "");
    const ramp = await shortestRampSec(appPage, stem.id);
    expect(ramp, "every automation ramp is at least 50 ms").toBeGreaterThanOrEqual(0.05 - 1e-6);

    await appPage.waitForTimeout(1000);
    const after = await withHooks(appPage, (h) => {
      const state = h.controller.store.getState();
      return { playing: state.playing, error: state.error, underruns: state.underruns };
    });
    if (audio) expect(after.playing, "playback survives the stroke").toBe(true);
    expect(after.error).toBeNull();
    console.log(
      `[brushes] ${testInfo.project.name}: "${commit?.batch.label}", shortest ramp ${(ramp * 1000).toFixed(1)} ms, underruns ${underrunsBefore} -> ${after.underruns}`,
    );

    // Undo restores the exact document.
    await appPage.locator("body").click({ position: { x: 1, y: 1 } });
    await appPage.keyboard.press(`${mod}+z`);
    await expect.poll(() => hookDoc(appPage)).toEqual(before);

    // Remove on the stem: one `region.clear` commit, then undo.
    await appPage.locator('input[type="radio"][value="remove"]').check({ force: true });
    const beforeRemove = (await historyView(appPage)).count;
    await stroke(appPage, stem.id, 20, 23);
    await appPage.mouse.up();
    await expect.poll(async () => (await historyView(appPage)).count).toBe(beforeRemove + 1);
    const removal = await withHooks(appPage, (h) => h.store.store.getState().lastCommit);
    expect(removal?.batch.ops.map((op) => op.op)).toEqual(["region.clear"]);
    await appPage.locator("body").click({ position: { x: 1, y: 1 } });
    await appPage.keyboard.press(`${mod}+z`);
    await expect.poll(() => hookDoc(appPage)).toEqual(before);

    await appPage.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
    expect(seriousOrCritical(await new AxeBuilder({ page: appPage }).analyze())).toEqual([]);
    expect(
      await withHooks(appPage, (h) => h.controller.store.getState().error),
      "the engine stayed healthy",
    ).toBeNull();
    expect(errors).toEqual([]);
  });
});
