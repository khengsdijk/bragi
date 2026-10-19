/**
 * The transport bar against the real web engine: the AudioWorklet and wasm that WP-1.1 left to be
 * exercised here (docs/wp/1.1.md "Deferred"). Generated audio only; nothing is committed.
 */
import { expect, test } from "./app-page.js";
import { canvasPoint, currentDoc, layout, openDemo, withHooks } from "./song-helpers.js";

test("plays the generated demo through the worklet, moves the playhead and mutes from a ribbon", async ({
  appPage,
}) => {
  const errors: string[] = [];
  appPage.on("pageerror", (e) => errors.push(e.message));
  appPage.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await openDemo(appPage);

  await appPage.getByRole("button", { name: "Play" }).click();
  await appPage.waitForFunction(
    () => {
      const hooks = (
        window as unknown as {
          __bragi?: {
            controller: {
              store: { getState(): { status: string; playing: boolean; positionSec: number } };
            };
          };
        }
      ).__bragi;
      const state = hooks?.controller.store.getState();
      return state?.status === "error" || (state?.playing === true && state.positionSec > 1);
    },
    undefined,
    { timeout: 30_000 },
  );
  const state = await withHooks(appPage, (h) => h.controller.store.getState());
  expect(state.error, errors.join("\n")).toBeNull();
  expect(state.status).toBe("ready");
  expect(state.playing).toBe(true);
  expect(state.positionSec).toBeGreaterThan(1);
  expect(state.underruns).toBe(0);
  // The button now offers Pause, and the time readout moved.
  await expect(appPage.getByRole("button", { name: "Pause" })).toBeVisible();
  await expect(appPage.getByTestId("transport-time")).not.toHaveText(/^00:00\.0 of/);

  // Audio is really being rendered: some instrument has a non-zero meter.
  const loud = await withHooks(appPage, async (h) => {
    let best = 0;
    for (let i = 0; i < 40; i += 1) {
      for (const v of Object.values(h.controller.store.getState().meters)) best = Math.max(best, v);
      if (best > 0.001) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return best;
  });
  expect(loud).toBeGreaterThan(0.001);

  // Solo from a ribbon changes the live mix: the other instruments go silent.
  const lanes = await layout(appPage);
  const lane = lanes.ribbons.find((l) => l.trackId === "trk_pads");
  if (!lane) throw new Error("no pads lane");
  const point = await canvasPoint(appPage, lane.solo.x + lane.solo.w / 2, lane.solo.y + 12);
  await appPage.mouse.click(point.x, point.y);
  expect((await currentDoc(appPage)).tracks.find((t) => t.id === "trk_pads")?.solo).toBe(true);
  await appPage.waitForTimeout(600);
  const meters = await withHooks(appPage, (h) => h.controller.store.getState().meters);
  const others = Object.entries(meters).filter(([id]) => id !== "trk_pads");
  expect(Math.max(...others.map(([, v]) => v))).toBeLessThan(0.001);

  // Pause stops the playhead.
  await appPage.getByRole("button", { name: "Pause" }).click();
  await appPage.waitForTimeout(300);
  const a = await withHooks(appPage, (h) => h.controller.store.getState().positionSec);
  await appPage.waitForTimeout(400);
  const b = await withHooks(appPage, (h) => h.controller.store.getState().positionSec);
  expect(b).toBeCloseTo(a, 2);
});
