/**
 * WP-2.8: move a section, Smooth with AI on the new boundary, accept, undo (07 §4.1; 09 §4.4).
 *
 *   analysed song -> drag Chorus 2 before Verse 2 (or the last part before the second) -> the
 *   ✨ Smooth with AI chip appears on the new boundary -> click: both sides render, ideas stream ->
 *   Accept: the section's `transitionIn` is `generated` with an asset -> play across the boundary
 *   without underruns -> undo restores the moved document exactly -> axe with the chip visible.
 *
 * The generation worker runs the **fake backend** (`BRAGI_GENERATION_BACKEND=fake`). Same gate and
 * stack as `section-flow.spec.ts` (`BRAGI_E2E_STACK=1`, single-user `dev:backend`).
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, test } from "./app-page.js";
import { canvasPoint, layout, withHooks } from "./song-helpers.js";
import {
  audioOutputRenders,
  barLengths,
  historyView,
  hookDoc,
  openAnalysedSong,
  SKIP_REASON,
  STACK,
  seriousOrCritical,
} from "./stack-helpers.js";

test.skip(!STACK, SKIP_REASON);

interface Span {
  id: string;
  x0: number;
  x1: number;
}

/** Each section's x range on the canvas, scanned along the section lane with `sectionAt`. */
async function sectionSpans(page: Page): Promise<Span[]> {
  const lanes = await layout(page);
  const width = (await page.getByTestId("song-canvas").locator("canvas").boundingBox())?.width;
  if (width === undefined) throw new Error("the canvas has no box");
  const y = lanes.sections.y + lanes.sections.h / 2;
  return withHooks(
    page,
    (hooks, arg) => {
      const spans: Span[] = [];
      for (let x = arg.from; x < arg.to; x += 1) {
        const id = hooks.canvas?.sectionAt(x, arg.y) ?? null;
        if (id === null) continue;
        const last = spans.at(-1);
        if (last?.id === id) last.x1 = x;
        else spans.push({ id, x0: x, x1: x });
      }
      return spans;
    },
    { from: lanes.gutter, to: width, y },
  );
}

test.describe("smoothing a moved boundary with AI", () => {
  test.setTimeout(600_000);

  test("move Chorus 2 before Verse 2, smooth it, accept, undo (fake backend)", async ({
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
    await withHooks(appPage, (hooks) => {
      hooks.canvas?.fit();
      hooks.canvas?.renderNow();
    });
    const before = await hookDoc(appPage);
    if (before === null) throw new Error("no document after analysis");
    const ids = before.arrangement.sections.map((section) => section.id);
    const labels = before.arrangement.sections.map((section) => section.label);
    expect(ids.length, "the analysis found at least three parts").toBeGreaterThanOrEqual(3);
    console.log(`[transition] ${testInfo.project.name}: ${labels.join(" | ")}`);

    // 07 §10 check 1's pair when the analysis has it, else the last part before the second.
    const chorus2 = labels.indexOf("Chorus 2");
    const verse2 = labels.indexOf("Verse 2");
    const [from, to] = chorus2 > verse2 && verse2 >= 0 ? [chorus2, verse2] : [ids.length - 1, 1];
    const movedId = ids[from] ?? "";
    const expected = ids.filter((id) => id !== movedId);
    expected.splice(to, 0, movedId);

    const spans = await sectionSpans(appPage);
    const grab = spans[from];
    const target = spans[to];
    if (grab === undefined || target === undefined) throw new Error("no spans");
    const lanes = await layout(appPage);
    const y = lanes.sections.y + lanes.sections.h / 2;
    const down = await canvasPoint(appPage, (grab.x0 + grab.x1) / 2, y);
    const drop = await canvasPoint(appPage, target.x0 + 3, y);
    const moveCount = (await historyView(appPage)).count;
    await appPage.mouse.move(down.x, down.y);
    await appPage.mouse.down();
    for (let step = 1; step <= 10; step += 1) {
      await appPage.mouse.move(down.x + ((drop.x - down.x) * step) / 10, down.y);
      await appPage.waitForTimeout(60);
    }
    await appPage.mouse.up();
    await expect.poll(async () => (await historyView(appPage)).count).toBe(moveCount + 1);
    expect((await hookDoc(appPage))?.arrangement.sections.map((section) => section.id)).toEqual(
      expected,
    );
    const moved = await hookDoc(appPage);
    if (moved === null) throw new Error("no document after the move");
    const moveHeading = await historyView(appPage);

    // The chip sits on a boundary the move created (the moved section's, or its follower's).
    const offered = await withHooks(
      appPage,
      (hooks) => hooks.offers?.store.getState().smooth.map((target) => target.sectionId) ?? [],
    );
    expect(offered.length, "the move offers a boundary to smooth").toBeGreaterThan(0);
    const smoothSectionId = offered.includes(movedId) ? movedId : (offered[0] ?? movedId);
    const chip = appPage.getByTestId(`smooth-chip-${smoothSectionId}`);
    await expect(chip).toBeVisible();
    expect(seriousOrCritical(await new AxeBuilder({ page: appPage }).analyze())).toEqual([]);
    await chip.click();
    const dialog = appPage.getByRole("dialog", { name: "Smooth this transition with AI" });
    await expect(dialog).toBeVisible();
    expect(
      await dialog.getByRole("radio", { name: "1 bar" }).isChecked(),
      "the default bridge is one bar",
    ).toBe(true);
    await dialog.getByRole("button", { name: "Generate" }).click();
    await expect(dialog).toBeHidden();

    const bar = appPage.getByRole("toolbar", { name: "Version ideas" });
    await expect(bar).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(
        () =>
          withHooks(appPage, (hooks) => {
            const state = hooks.audition?.store.getState();
            return [...(state?.warm ?? [])].sort();
          }),
        { timeout: 300_000 },
      )
      .toEqual([1, 2, 3]);
    await bar.getByRole("button", { name: "Accept" }).click();
    await expect(bar).toBeHidden();
    await expect
      .poll(() => withHooks(appPage, (hooks) => hooks.smooth?.store.getState().phase ?? "none"), {
        timeout: 30_000,
      })
      .toBe("accepted");

    // The incoming section now enters through a generated transition with the candidate's asset.
    const settled = async () => {
      const doc = await hookDoc(appPage);
      const section = doc?.arrangement.sections.find((entry) => entry.id === smoothSectionId);
      const source = doc?.sources?.find(
        (entry) =>
          entry.kind === "generated" && entry.workingAsset === section?.transitionIn?.asset,
      );
      return {
        kind: section?.transitionIn?.kind ?? null,
        hasAsset: typeof section?.transitionIn?.asset === "string",
        source: source !== undefined,
      };
    };
    await expect
      .poll(
        async () => {
          const value = await settled();
          return { kind: value.kind, hasAsset: value.hasAsset, source: value.source };
        },
        { timeout: 120_000, intervals: [1_000] },
      )
      .toEqual({ kind: "generated", hasAsset: true, source: true });
    console.log(
      `[transition] ${testInfo.project.name}: section ${smoothSectionId} enters through a bridge`,
    );

    // Play across the boundary: seek one second before it and let the transport run.
    if (audio) {
      const doc = await hookDoc(appPage);
      if (doc === null) throw new Error("no document to play");
      const bars = barLengths(doc);
      let boundaryTick = 0;
      for (const section of doc.arrangement.sections) {
        if (section.id === smoothSectionId) break;
        boundaryTick += section.lengthTicks;
      }
      const underrunsBefore = await withHooks(
        appPage,
        (hooks) => hooks.controller.store.getState().underruns,
      );
      await withHooks(
        appPage,
        (hooks, sec) => {
          hooks.controller.seek(sec);
          void hooks.controller.play();
        },
        Math.max(0, (boundaryTick / bars.ticks) * bars.sec - 1),
      );
      await appPage.waitForTimeout(3000);
      const playback = await withHooks(appPage, (hooks) => {
        const state = hooks.controller.store.getState();
        return { playing: state.playing, error: state.error, underruns: state.underruns };
      });
      expect(playback.playing, "playback continues across the generated transition").toBe(true);
      expect(playback.error).toBeNull();
      console.log(
        `[transition] ${testInfo.project.name}: underruns ${underrunsBefore} -> ${playback.underruns}`,
      );
    }

    // Undo returns to the moved document exactly.
    await appPage.locator("body").click({ position: { x: 1, y: 1 } });
    for (let step = 0; step < 12; step += 1) {
      const head = await historyView(appPage).then((history) => history.head);
      if (head === moveHeading.head) break;
      await appPage.keyboard.press(`${mod}+z`);
      await appPage.waitForTimeout(400);
    }
    await expect
      .poll(() => historyView(appPage).then((history) => history.head))
      .toBe(moveHeading.head);
    await expect.poll(() => hookDoc(appPage), { timeout: 30_000 }).toEqual(moved);
    expect(errors).toEqual([]);
  });
});
