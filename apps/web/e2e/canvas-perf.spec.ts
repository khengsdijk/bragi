/**
 * The 07 §9 budgets, measured: "60 fps while playing and zooming ... a 10-minute song with 12
 * ribbons, and a frame time <= 8 ms for rendering. Opening a cached project shows a first canvas
 * in < 500 ms."
 *
 * What is and is not measured, so the numbers are not over-read:
 *
 * - **fps** is the page's `requestAnimationFrame` cadence while the canvas plays and while it zooms
 *   and pans: end to end, including the GPU, as far as the compositor lets rAF run.
 * - **render ms** is the CPU time of `renderer.render()` per frame (command submission). GPU
 *   execution time is not measured here (no timestamp queries), and the machine is whatever runs
 *   this, not a 2020 integrated GPU. `docs/wp/1.9.md` records the machine.
 * - **first canvas** is page navigation to the first drawn frame, *warm* (the wasm and fonts are
 *   cached by the browser from a previous visit), for the short demo; the cold number is logged too.
 *
 * Chromium only (the budgets are one-platform numbers); WebGL2 and WebGPU are both measured.
 */
import { mkdirSync, writeFileSync } from "node:fs";

import { expect, test } from "./app-page.js";
import { openDemo, withHooks } from "./song-helpers.js";

test.beforeEach(({ browserName }, testInfo) => {
  test.skip(
    browserName !== "chromium" ||
      !["chromium-webgl", "chromium-webgpu"].includes(testInfo.project.name),
    "performance budgets are measured in the two GPU Chromium projects",
  );
});

interface Sample {
  readonly fps: number;
  readonly frameMsP50: number;
  readonly frameMsP95: number;
  readonly frameMsMax: number;
  readonly renderMsMean: number;
  readonly renderMsP95: number;
  readonly renderMsMax: number;
  readonly frames: number;
}

test("10-minute song with 12 ribbons: 60 fps playing and zooming, render <= 8 ms", async ({
  appPage,
}, testInfo) => {
  const renderer = testInfo.project.name === "chromium-webgpu" ? "webgpu" : "webgl";
  await openDemo(appPage, { audio: false, minutes: 10, tracks: 12, renderer });
  const info = await withHooks(appPage, (h) => ({
    renderer: h.canvas?.rendererName,
    tracks: h.store.store.getState().doc?.tracks.length,
    sections: h.store.store.getState().doc?.arrangement.sections.length,
  }));
  expect(info.renderer).toBe(renderer);
  expect(info.tracks).toBe(12);

  const run = (scenario: "play" | "zoom") =>
    appPage.evaluate(async (which): Promise<Sample> => {
      const hooks = (
        window as unknown as {
          __bragi: {
            canvas: {
              setViewport(v: { pxPerBeat: number; originSec: number }): void;
              setPlaying(p: boolean): void;
              setPlayhead(s: number): void;
              zoomBy(f: number, x?: number): void;
              panByPx(d: number): void;
              settle(): void;
              resetStats(): void;
              stats(): { lastRenderMs: number };
            };
          };
        }
      ).__bragi;
      const canvas = hooks.canvas;
      // A working zoom: 24 px per beat is the L2-near level, where the most geometry is live.
      canvas.setViewport({ pxPerBeat: 24, originSec: 0 });
      canvas.settle();
      canvas.resetStats();
      const intervals: number[] = [];
      const renders: number[] = [];
      let last = performance.now();
      const start = last;
      const durationMs = 5000;
      let step = 0;
      await new Promise<void>((resolve) => {
        const tick = (now: number): void => {
          intervals.push(now - last);
          last = now;
          renders.push(canvas.stats().lastRenderMs);
          step += 1;
          if (which === "play") {
            canvas.setPlaying(true);
            canvas.setPlayhead((now - start) / 1000);
          } else {
            // Zoom in and out around the middle while panning, every frame.
            canvas.zoomBy(step % 120 < 60 ? 1.03 : 1 / 1.03, 600);
            canvas.panByPx(step % 40 < 20 ? 3 : -3);
          }
          if (now - start < durationMs) requestAnimationFrame(tick);
          else resolve();
        };
        requestAnimationFrame(tick);
      });
      canvas.setPlaying(false);
      const sorted = (values: number[]): number[] => [...values].sort((a, b) => a - b);
      const pct = (values: number[], p: number): number =>
        sorted(values)[Math.min(values.length - 1, Math.floor(values.length * p))] ?? 0;
      const body = intervals.slice(2);
      const rbody = renders.slice(2);
      const total = body.reduce((a, b) => a + b, 0);
      return {
        fps: (body.length / total) * 1000,
        frameMsP50: pct(body, 0.5),
        frameMsP95: pct(body, 0.95),
        frameMsMax: Math.max(...body),
        renderMsMean: rbody.reduce((a, b) => a + b, 0) / rbody.length,
        renderMsP95: pct(rbody, 0.95),
        renderMsMax: Math.max(...rbody),
        frames: body.length,
      };
    }, scenario);

  const playing = await run("play");
  const zooming = await run("zoom");
  // `info.renderer` already carries the backend the canvas reported; assert above that it is the
  // one we asked for, then log it once (a second `renderer` key here would be shadowed and is a
  // compile error under `web#build`'s `tsc --noEmit`).
  const result = { project: testInfo.project.name, ...info, playing, zooming };
  console.log(`[perf] ${JSON.stringify(result)}`);
  mkdirSync("test-results", { recursive: true });
  writeFileSync(
    `test-results/canvas-perf-${testInfo.project.name}.json`,
    JSON.stringify(result, null, 2),
  );

  for (const [name, sample] of [
    ["playing", playing],
    ["zooming", zooming],
  ] as const) {
    expect(sample.fps, `${name} fps`).toBeGreaterThanOrEqual(55);
    expect(sample.renderMsP95, `${name} p95 render ms`).toBeLessThanOrEqual(8);
  }
});

test("opening a cached project shows a first canvas in under 500 ms", async ({
  appPage,
}, testInfo) => {
  const renderer = testInfo.project.name === "chromium-webgpu" ? "webgpu" : "webgl";
  // Cold: the first visit in this browser profile (no caches).
  const cold = await openDemo(appPage, { audio: false, renderer });
  // Warm: a second navigation, with the wasm, fonts and chunks cached by the browser.
  const warm: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    await appPage.goto("/favicon.svg");
    warm.push(await openDemo(appPage, { audio: false, renderer }));
  }
  const sorted = [...warm].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  console.log(
    `[perf] first canvas ${testInfo.project.name}: cold ${cold} ms, warm ${warm.join("/")} ms, median ${median} ms`,
  );
  mkdirSync("test-results", { recursive: true });
  writeFileSync(
    `test-results/canvas-first-${testInfo.project.name}.json`,
    JSON.stringify({ cold, warm, median }, null, 2),
  );
  expect(median).toBeLessThan(500);
});
