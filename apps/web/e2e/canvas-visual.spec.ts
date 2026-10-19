/**
 * Visual regression with WebGPU on and off (13 §6, 07 §10 check 5: "With WebGPU disabled, all
 * lanes render identically").
 *
 * Both runs compare against the *same* golden image (see `snapshotPathTemplate` in the Playwright
 * config). `chromium-webgl` has no WebGPU adapter in headless mode, so Pixi falls back to
 * WebGL2: that run is the fallback. `chromium-webgpu` opts into a real adapter. Each test asserts
 * which backend actually drew, so a silent fallback cannot pass as "WebGPU on".
 *
 * Chromium only: text and anti-aliasing differ between engines, and 13 §6 puts visual regression
 * on one platform. Goldens are the macOS ones; Linux goldens are not generated here.
 */
import { expect, test } from "./app-page.js";
import { openDemo, withHooks } from "./song-helpers.js";

test.beforeEach(({ browserName }, testInfo) => {
  test.skip(
    browserName !== "chromium" ||
      !["chromium-webgl", "chromium-webgpu"].includes(testInfo.project.name),
    "visual regression runs in the two GPU Chromium projects",
  );
});

async function settled(
  page: Parameters<typeof openDemo>[0],
  options: Parameters<typeof openDemo>[1],
  projectName: string,
) {
  const expected = projectName === "chromium-webgpu" ? "webgpu" : "webgl";
  // "WebGPU off" forces the WebGL2 renderer; the browser may well offer WebGPU on its own.
  await openDemo(page, { ...options, renderer: expected });
  const renderer = await withHooks(page, (h) => h.canvas?.rendererName ?? "none");
  expect(renderer, "the backend that actually drew").toBe(expected);
  await withHooks(page, (h) => {
    h.canvas?.settle();
  });
  await page.evaluate(() => document.fonts.ready);
  await withHooks(page, (h) => {
    h.canvas?.settle();
  });
}

test("the full song, every lane", async ({ appPage }, testInfo) => {
  await settled(appPage, { audio: false }, testInfo.project.name);
  await expect(appPage.getByTestId("song-canvas")).toHaveScreenshot("song-canvas-full.png");
});

test("only the first analysis stages: one block, one mix ribbon, shimmer placeholders", async ({
  appPage,
}, testInfo) => {
  await settled(appPage, { audio: false, stages: "ingest,rhythm" }, testInfo.project.name);
  await expect(appPage.getByTestId("song-canvas")).toHaveScreenshot("song-canvas-progressive.png");
});

test("zoomed to the Moment level: waveform lanes", async ({ appPage }, testInfo) => {
  await settled(appPage, { audio: false }, testInfo.project.name);
  await withHooks(appPage, (h) => {
    h.canvas?.setViewport({ pxPerBeat: 96, originSec: 10 });
    h.canvas?.settle();
  });
  expect(await withHooks(appPage, (h) => h.canvas?.getLevel())).toBe("L3");
  await expect(appPage.getByTestId("song-canvas")).toHaveScreenshot("song-canvas-moment.png");
});

test("a part and an instrument selected, one instrument muted", async ({ appPage }, testInfo) => {
  await settled(appPage, { audio: false, sel: "s:sec_002" }, testInfo.project.name);
  await appPage
    .getByTestId("grid-mute-trk_bass")
    .evaluate((button) => (button as HTMLElement).click());
  await withHooks(appPage, (h) => {
    h.canvas?.settle();
  });
  await expect(appPage.getByTestId("song-canvas")).toHaveScreenshot(
    "song-canvas-selected-muted.png",
  );
});
