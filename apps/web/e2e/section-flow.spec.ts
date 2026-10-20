/**
 * WP-2.2: section editing on a real song, while it plays, against the live local stack.
 *
 *   upload -> play -> drag a later part before an earlier one on the canvas (07 §10 check 1):
 *   the document does not change during the drag, one commit on release (one `section.move` plus
 *   its smooth joins), playback keeps running -> undo restores the exact document -> Alt+→ from
 *   the keyboard commits once and undoes -> the command palette duplicates a part -> axe.
 *
 * The fixture's sections come from the analysis, so the spec reads their spans from the canvas
 * (`sectionAt`) instead of assuming labels. Whether the boundaries *sound* clean is covered by the
 * engine's discontinuity tests (task A). Same gate as `upload-flow.spec.ts`
 * (`BRAGI_E2E_STACK=1`, single-user `dev:backend`).
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, test } from "./app-page.js";
import { canvasPoint, layout, withHooks } from "./song-helpers.js";
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

interface Span {
  id: string;
  x0: number;
  x1: number;
}

const sectionIds = async (page: Page): Promise<string[]> =>
  ((await hookDoc(page))?.arrangement.sections ?? []).map((section) => section.id);

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

test.describe("section editing on a real song", () => {
  test.setTimeout(300_000);

  test("drag while playing, one commit, undo, keyboard and palette", async ({
    appPage,
  }, testInfo) => {
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
      console.warn(`[sections] ${testInfo.project.name}: NO AUDIO OUTPUT, playback not checked`);
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

    // The whole song on screen, so every block can be grabbed.
    await withHooks(appPage, (h) => {
      h.canvas?.fit();
      h.canvas?.renderNow();
    });
    const before = await hookDoc(appPage);
    if (before === null) throw new Error("no document");
    const ids = before.arrangement.sections.map((section) => section.id);
    const labels = before.arrangement.sections.map((section) => section.label);
    console.log(`[sections] ${testInfo.project.name}: ${labels.join(" | ")}`);
    expect(ids.length, "the analysis found at least three parts").toBeGreaterThanOrEqual(3);

    // 07 §10 check 1 names "Chorus 2 before Verse 2"; use that pair when the analysis has it,
    // otherwise move the last part before the second one.
    const chorus2 = labels.indexOf("Chorus 2");
    const verse2 = labels.indexOf("Verse 2");
    const [from, to] = chorus2 > verse2 && verse2 >= 0 ? [chorus2, verse2] : [ids.length - 1, 1];
    const movedId = ids[from] ?? "";
    const expected = ids.filter((id) => id !== movedId);
    expected.splice(to, 0, movedId);

    const spans = await sectionSpans(appPage);
    expect(spans.map((span) => span.id)).toEqual(ids);
    const grab = spans[from];
    const target = spans[to];
    if (grab === undefined || target === undefined) throw new Error("no spans");
    const lanes = await layout(appPage);
    const y = lanes.sections.y + lanes.sections.h / 2;

    // Drag: grab the body's middle, drop just inside the target's left edge (left of its centre).
    const start = await historyView(appPage);
    const underrunsBefore = await withHooks(
      appPage,
      (h) => h.controller.store.getState().underruns,
    );
    const down = await canvasPoint(appPage, (grab.x0 + grab.x1) / 2, y);
    const drop = await canvasPoint(appPage, target.x0 + 3, y);
    await appPage.mouse.move(down.x, down.y);
    await appPage.mouse.down();
    for (let step = 1; step <= 10; step += 1) {
      await appPage.mouse.move(down.x + ((drop.x - down.x) * step) / 10, down.y);
      await appPage.waitForTimeout(60);
    }
    const during = await withHooks(appPage, (h) => {
      const state = h.store.store.getState();
      return {
        doc: state.doc?.arrangement.sections.map((section) => section.id) ?? [],
        preview: state.preview?.arrangement.sections.map((section) => section.id) ?? null,
      };
    });
    expect(during.doc, "the document does not change during a drag").toEqual(ids);
    expect(during.preview, "the preview shows the drop slot").toEqual(expected);
    if (audio) {
      expect(await withHooks(appPage, (h) => h.controller.store.getState().playing)).toBe(true);
    }
    await appPage.mouse.up();

    await expect.poll(async () => (await historyView(appPage)).count).toBe(start.count + 1);
    expect(await sectionIds(appPage)).toEqual(expected);
    const commit = await withHooks(appPage, (h) => h.store.store.getState().lastCommit);
    const moves = commit?.batch.ops.filter((op) => op.op === "section.move") ?? [];
    expect(moves).toHaveLength(1);
    expect(
      commit?.batch.ops.every(
        (op) => op.op === "section.move" || op.op === "section.set_transition",
      ),
      "only the move and its smooth joins",
    ).toBe(true);
    expect((await historyView(appPage)).headLabel).toBe(commit?.batch.label);
    await expect(appPage.getByTestId("live-region")).toHaveText(commit?.batch.label ?? "");

    await appPage.waitForTimeout(1000);
    const after = await withHooks(appPage, (h) => {
      const state = h.controller.store.getState();
      return { playing: state.playing, error: state.error, underruns: state.underruns };
    });
    if (audio) expect(after.playing, "playback survives the move").toBe(true);
    expect(after.error).toBeNull();
    console.log(
      `[sections] ${testInfo.project.name}: "${commit?.batch.label}", underruns ${underrunsBefore} -> ${after.underruns}`,
    );

    // Undo restores the exact document.
    await appPage.locator("body").click({ position: { x: 1, y: 1 } });
    await appPage.keyboard.press(`${mod}+z`);
    await expect.poll(() => hookDoc(appPage)).toEqual(before);

    // Keyboard: select the first part in the grid, Alt+→ moves it one place in one commit.
    const cell = appPage.locator('[data-testid="song-grid"] td[tabindex="0"]');
    await cell.focus();
    await appPage.keyboard.press("Enter");
    const beforeKey = (await historyView(appPage)).count;
    await appPage.keyboard.press("Alt+ArrowRight");
    await expect.poll(async () => (await historyView(appPage)).count).toBe(beforeKey + 1);
    expect(await sectionIds(appPage)).toEqual([ids[1], ids[0], ...ids.slice(2)]);
    await appPage.keyboard.press(`${mod}+z`);
    await expect.poll(() => hookDoc(appPage)).toEqual(before);

    // The palette runs "Duplicate part" on the selected part: one more commit.
    await cell.focus();
    await appPage.keyboard.press("Control+k");
    const palette = appPage.getByRole("dialog", { name: "Commands" });
    await expect(palette).toBeVisible();
    expect(seriousOrCritical(await new AxeBuilder({ page: appPage }).analyze())).toEqual([]);
    const beforePalette = (await historyView(appPage)).count;
    await appPage.getByRole("combobox").fill("duplicate");
    await expect(appPage.getByRole("option", { name: /Duplicate part/ })).toBeVisible();
    await appPage.keyboard.press("Enter");
    await expect(palette).toBeHidden();
    await expect.poll(async () => (await historyView(appPage)).count).toBe(beforePalette + 1);
    expect(await sectionIds(appPage)).toHaveLength(ids.length + 1);

    expect(
      await withHooks(appPage, (h) => h.controller.store.getState().error),
      "the engine stayed healthy",
    ).toBeNull();
    expect(errors).toEqual([]);
  });
});
