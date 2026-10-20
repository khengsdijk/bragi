/**
 * WP-2.3: the Inspector on a real song, while it plays, against the live local stack.
 *
 *   upload -> play (before the stems land) -> select a stem from the accessible grid -> the Inspector opens -> drag
 *   "Space": the document does not change during the drag (01 §5), one commit on release adds
 *   the macro-owned effects, playback keeps running -> undo puts the slider back to Unchanged ->
 *   redo -> arrow keys on "Brightness" commit once per step -> reload: the vibe survives ->
 *   axe with the expert drawer open.
 *
 * Whether it *sounds* right (no clicks while the slider moves) is a listening check
 * (docs/wp/2.3.md, manual checks); this spec proves the wiring and the engine staying healthy.
 * Same gate as `upload-flow.spec.ts` (`BRAGI_E2E_STACK=1`, single-user `dev:backend`).
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

interface FxLike {
  type: string;
  macroOwned?: string;
  params: Record<string, number>;
}

/** The effects on `trackId` in the live document. */
const trackFx = (page: Page, trackId: string): Promise<FxLike[]> =>
  hookDoc(page).then(
    (doc) =>
      ((doc?.tracks.find((track) => track.id === trackId) as { fx?: FxLike[] } | undefined)?.fx ??
        []) as FxLike[],
  );

const previewActive = (page: Page): Promise<boolean> =>
  withHooks(
    page,
    (hooks) =>
      (hooks.store.store.getState() as unknown as { preview: unknown }).preview !== null &&
      (hooks.store.store.getState() as unknown as { preview: unknown }).preview !== undefined,
  );

/** Moves grid focus down to the row of `trackId` and selects it with Enter. */
async function selectTrack(page: Page, trackId: string): Promise<void> {
  await page.locator('[data-testid="song-grid"] td[tabindex="0"]').focus();
  for (let press = 0; press < 30; press += 1) {
    const row = await page.evaluate(
      () => (document.activeElement?.closest("tr") as HTMLElement | null)?.dataset.rowId ?? "",
    );
    if (row === trackId) {
      await page.keyboard.press("Enter");
      return;
    }
    await page.keyboard.press("ArrowDown");
  }
  throw new Error(`no grid row for ${trackId}`);
}

test.describe("the Inspector on a real song", () => {
  test.setTimeout(300_000);

  test("vibe sliders preview while dragging, commit once, undo and persist", async ({
    appPage,
  }, testInfo) => {
    const errors: string[] = [];
    appPage.on("pageerror", (e) => errors.push(e.message));
    const mod = process.platform === "darwin" ? "Meta" : "Control";

    // Play before the stems land, as a user does right after uploading. Without a working audio
    // output on this machine no engine can play: then only the playback checks are skipped, loudly.
    await appPage.goto("/#/");
    const audio = await audioOutputRenders(appPage);
    if (!audio) {
      testInfo.annotations.push({
        type: "audio",
        description: "this machine's audio output does not render: playback was not checked",
      });
      console.warn(`[inspector] ${testInfo.project.name}: NO AUDIO OUTPUT, playback not checked`);
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
    const stem = visible(await hookDoc(appPage)).find((track) => track.role !== "full_mix");
    if (stem === undefined) throw new Error("no stem");
    if (audio) {
      expect(
        await withHooks(appPage, (h) => h.controller.store.getState().playing),
        "still playing after the analysis landed",
      ).toBe(true);
    }

    await selectTrack(appPage, stem.id);
    const panel = appPage.getByTestId("inspector-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(stem.name);

    // Drag "Space" with the mouse: a gesture on the preview copy, one commit on release.
    const before = await hookDoc(appPage);
    const start = await historyView(appPage);
    const underrunsBefore = await withHooks(
      appPage,
      (h) => h.controller.store.getState().underruns,
    );
    const space = panel.getByRole("slider", { name: "Space" });
    await expect(space).toHaveAttribute("aria-valuetext", "Unchanged");
    const box = await space.boundingBox();
    if (box === null) throw new Error("no Space thumb");
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await appPage.mouse.move(x, y);
    await appPage.mouse.down();
    for (let step = 1; step <= 6; step += 1) {
      await appPage.mouse.move(x + step * 12, y);
      await appPage.waitForTimeout(80);
    }
    expect(await previewActive(appPage), "the drag previews on a copy").toBe(true);
    expect(await hookDoc(appPage), "the document does not change during a drag").toEqual(before);
    await appPage.mouse.up();

    await expect.poll(async () => (await historyView(appPage)).count).toBe(start.count + 1);
    expect(await previewActive(appPage)).toBe(false);
    const owned = (await trackFx(appPage, stem.id)).filter((fx) => fx.macroOwned === "space");
    expect(owned.map((fx) => fx.type).sort()).toEqual(["reverb", "width"]);
    const spaceText = await space.getAttribute("aria-valuetext");
    expect(spaceText).not.toBe("Unchanged");
    const head = await historyView(appPage);
    expect(head.headLabel).toBe(`Space on ${stem.name}`);

    await appPage.waitForTimeout(1000);
    const after = await withHooks(appPage, (h) => {
      const state = h.controller.store.getState();
      return { playing: state.playing, error: state.error, underruns: state.underruns };
    });
    if (audio) expect(after.playing, "playback survives the edit").toBe(true);
    expect(after.error).toBeNull();
    console.log(
      `[inspector] ${testInfo.project.name}: underruns ${underrunsBefore} -> ${after.underruns} across the Space drag`,
    );

    // Undo puts the document and the slider back; redo brings the vibe back.
    await appPage.locator("body").click({ position: { x: 1, y: 1 } });
    await appPage.keyboard.press(`${mod}+z`);
    await expect.poll(() => hookDoc(appPage)).toEqual(before);
    await expect(space).toHaveAttribute("aria-valuetext", "Unchanged");
    await appPage.keyboard.press(`${mod}+Shift+z`);
    await expect(space).toHaveAttribute("aria-valuetext", spaceText ?? "");

    // Arrow keys: one commit per step.
    const beforeKeys = (await historyView(appPage)).count;
    const brightness = panel.getByRole("slider", { name: "Brightness" });
    await brightness.focus();
    await appPage.keyboard.press("ArrowRight");
    await appPage.keyboard.press("ArrowRight");
    await expect.poll(async () => (await historyView(appPage)).count).toBe(beforeKeys + 2);
    const brightText = await brightness.getAttribute("aria-valuetext");
    expect(brightText).not.toBe("Unchanged");

    // Reload: the vibe comes back from the stored version.
    await appPage.reload();
    await expect(appPage.getByTestId("song-workspace")).toBeVisible({ timeout: 60_000 });
    await expect
      .poll(async () => (await trackFx(appPage, stem.id)).some((fx) => fx.macroOwned === "space"))
      .toBe(true);
    await selectTrack(appPage, stem.id);
    await expect(appPage.getByTestId("inspector-panel")).toBeVisible();
    await expect(
      appPage.getByTestId("inspector-panel").getByRole("slider", { name: "Space" }),
    ).toHaveAttribute("aria-valuetext", spaceText ?? "");

    await appPage.getByRole("button", { name: "Expert" }).click();
    await expect(appPage.getByTestId("inspector-expert")).toBeVisible();
    expect(seriousOrCritical(await new AxeBuilder({ page: appPage }).analyze())).toEqual([]);
    expect(errors).toEqual([]);
  });
});
