/**
 * Cold reopen: a song whose analysis already finished (stems in the document) must play from a
 * single Play click after a page reload.
 *
 * This is the regression the web host had before the decoder-worker split: the worklet decoded
 * every asset inside its `load` handler, which blocked the audio render thread long enough for
 * Chromium to stop rendering, and Firefox created/resumed the context too late to count as a user
 * gesture. The test asserts the transport reaches `playing`, the playhead advances, and the
 * `AudioContext` is `running` with an advancing `currentTime`.
 *
 * Same stack and gate as `upload-flow.spec.ts` (`BRAGI_E2E_STACK=1`, single-user `dev:backend`).
 * Register it with `pnpm test:e2e:flow`; do not run the live stack in CI with no backend.
 */
import type { Page } from "@playwright/test";

import { expect, test } from "./app-page.js";
import { withHooks } from "./song-helpers.js";
import { hookDoc, openAnalysedSong, SKIP_REASON, STACK } from "./stack-helpers.js";

test.skip(!STACK, SKIP_REASON);

interface AudioSnapshot {
  readonly state: AudioContextState;
  readonly currentTime: number;
}

/** Records every `AudioContext` the page creates, so the spec can read the real one. */
async function captureAudioContexts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const scope = window as unknown as {
      AudioContext: typeof AudioContext;
      __bragiAudioContexts?: AudioContext[];
    };
    const Original = scope.AudioContext;
    if (Original === undefined) return;
    scope.__bragiAudioContexts = [];
    class Tracked extends Original {
      constructor(options?: AudioContextOptions) {
        super(options);
        scope.__bragiAudioContexts?.push(this);
      }
    }
    scope.AudioContext = Tracked;
  });
}

/** The newest context's state and clock, or `null` before Play created one. */
function audioSnapshot(page: Page): Promise<AudioSnapshot | null> {
  return page.evaluate(() => {
    const scope = window as unknown as { __bragiAudioContexts?: AudioContext[] };
    const context = scope.__bragiAudioContexts?.at(-1) ?? null;
    return context === null ? null : { state: context.state, currentTime: context.currentTime };
  });
}

test.describe("cold reopen of an analysed song", () => {
  test.setTimeout(300_000);

  test("plays after one Play click, with a running AudioContext", async ({ appPage }, testInfo) => {
    await captureAudioContexts(appPage);

    const projectId = await openAnalysedSong(appPage);
    const analysed = await hookDoc(appPage);
    expect(analysed?.tracks.length ?? 0).toBeGreaterThan(2);

    // Reload: the stored snapshot reopens with every stem, but the engine is cold.
    await appPage.reload();
    await expect(appPage.getByTestId("song-workspace")).toBeVisible({ timeout: 60_000 });
    await expect(appPage.getByTestId("project-id")).toHaveText(projectId);
    await expect
      .poll(async () => (await hookDoc(appPage))?.tracks.length ?? 0, { timeout: 60_000 })
      .toBe(analysed?.tracks.length);
    expect(await audioSnapshot(appPage)).toBeNull();

    // One click. The controller must unlock the context synchronously and only then load.
    const t0 = Date.now();
    await appPage.getByRole("button", { name: "Play" }).click();

    await expect
      .poll(
        () =>
          withHooks(appPage, (hooks) => {
            const state = hooks.controller.store.getState();
            if (state.status === "error") return -1;
            return state.playing ? state.positionSec : 0;
          }),
        { timeout: 10_000, intervals: [100] },
      )
      .toBeGreaterThan(0);
    console.log(`[timing] ${testInfo.project.name}: Play -> playing ${Date.now() - t0} ms`);

    const context = await audioSnapshot(appPage);
    expect(context).not.toBeNull();
    if (context === null) throw new Error("no AudioContext was created");
    expect(context.state).toBe("running");

    // The playhead and the context clock both advance; a stopped render thread leaves both frozen.
    const first = await withHooks(
      appPage,
      (hooks) => hooks.controller.store.getState().positionSec,
    );
    const before = context.currentTime;
    await appPage.waitForTimeout(750);
    const later = await audioSnapshot(appPage);
    const second = await withHooks(
      appPage,
      (hooks) => hooks.controller.store.getState().positionSec,
    );
    expect(second).toBeGreaterThan(first);
    expect(later?.state).toBe("running");
    expect(later?.currentTime ?? 0).toBeGreaterThan(before);
    await expect(appPage.getByRole("button", { name: "Pause" })).toBeVisible();
  });
});
