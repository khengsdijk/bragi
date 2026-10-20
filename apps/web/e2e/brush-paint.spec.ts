/**
 * WP-2.4: painting instant brushes on the demo song (07 §4.4, §10 check 3).
 *
 *   Paint on -> Space -> a mouse stroke across a ribbon commits once, announces its plain-language
 *   label and leaves automation whose first ramp is at least 50 ms -> a synthetic pen stroke with
 *   varying pressure commits once too -> Escape mid-stroke commits nothing -> axe with the palette
 *   visible. The demo has no version tree, so "one commit" is `revision + 1` and `lastCommit`.
 *
 * The pen part is skipped in Firefox: Playwright's Firefox does not expose pen pointer events
 * through `dispatchEvent` reliably. Chromium and WebKit cover the 07 acceptance criterion.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, test } from "./app-page.js";
import { currentDoc, openDemo, ribbonPoint, withHooks } from "./song-helpers.js";
import { seriousOrCritical } from "./stack-helpers.js";

interface PaintPoint {
  readonly tick: number;
  readonly value: number;
}

interface PaintAutomation {
  readonly target: string;
  readonly points: readonly PaintPoint[];
}

interface PaintDoc {
  readonly arrangement: {
    readonly timebase: {
      readonly ppq: number;
      readonly tempoMap: readonly { readonly bpm: number; readonly tick: number }[];
    };
    readonly sections: readonly {
      readonly lanes: Readonly<Record<string, { readonly automation: readonly PaintAutomation[] }>>;
    }[];
  };
}

interface StoreState {
  readonly revision: number;
  readonly lastCommit: { readonly batch: { readonly label: string } } | null;
}

function state(page: Page): Promise<StoreState> {
  return withHooks(page, (hooks) => {
    const value = hooks.store.store.getState();
    return {
      revision: value.revision,
      lastCommit:
        value.lastCommit === null ? null : { batch: { label: value.lastCommit.batch.label } },
    };
  });
}

/** Every automation entry on `trackId`, across the arrangement's sections. */
function automationFor(doc: PaintDoc, trackId: string): PaintAutomation[] {
  return doc.arrangement.sections.flatMap((section) => section.lanes[trackId]?.automation ?? []);
}

/** The longest first-two-point ramp on a track, in seconds, through the first tempo. */
function firstRampSec(doc: PaintDoc, trackId: string): number {
  const ppq = doc.arrangement.timebase.ppq;
  const bpm = doc.arrangement.timebase.tempoMap[0]?.bpm ?? 120;
  let longest = 0;
  for (const entry of automationFor(doc, trackId)) {
    const [left, right] = entry.points;
    if (left === undefined || right === undefined || left.value === right.value) continue;
    longest = Math.max(longest, ((right.tick - left.tick) / ppq) * (60 / bpm));
  }
  return longest;
}

async function paintWithMouse(page: Page, trackId: string, fromSec: number, toSec: number) {
  const from = await ribbonPoint(page, trackId, fromSec);
  const to = await ribbonPoint(page, trackId, toSec);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(from.x + ((to.x - from.x) * step) / 8, from.y);
    await page.waitForTimeout(20);
  }
  await page.mouse.up();
}

async function paintWithPen(page: Page, trackId: string, fromSec: number, toSec: number) {
  const from = await ribbonPoint(page, trackId, fromSec);
  const to = await ribbonPoint(page, trackId, toSec);
  const canvas = page.getByTestId("song-canvas").locator("canvas");
  const base = {
    pointerId: 7,
    pointerType: "pen",
    isPrimary: true,
    button: 0,
    bubbles: true,
    cancelable: true,
  } as const;
  await canvas.dispatchEvent("pointerdown", {
    ...base,
    buttons: 1,
    pressure: 0.25,
    clientX: from.x,
    clientY: from.y,
  });
  for (const [step, pressure] of [0.45, 0.7, 0.95].entries()) {
    await canvas.dispatchEvent("pointermove", {
      ...base,
      buttons: 1,
      pressure,
      clientX: from.x + ((to.x - from.x) * (step + 1)) / 4,
      clientY: from.y,
    });
    await page.waitForTimeout(30);
  }
  await canvas.dispatchEvent("pointerup", {
    ...base,
    buttons: 0,
    pressure: 0,
    clientX: to.x,
    clientY: to.y,
  });
}

test.describe("painting instant brushes", () => {
  test.setTimeout(120_000);

  test("mouse and pen strokes, Escape, and the palette pass axe", async ({ appPage }, testInfo) => {
    const errors: string[] = [];
    appPage.on("pageerror", (error) => errors.push(error.message));

    await openDemo(appPage, { audio: false });
    const paint = appPage.getByTestId("brush-paint-toggle");
    await expect(paint).toHaveAttribute("aria-pressed", "false");
    await paint.click();
    await expect(paint).toHaveAttribute("aria-pressed", "true");
    await appPage.locator('input[type="radio"][value="space"]').check({ force: true });

    // A mouse stroke across the drum ribbon: one commit and a 50 ms ramp.
    const before = await state(appPage);
    await paintWithMouse(appPage, "trk_drums", 5, 6.5);
    await expect.poll(async () => (await state(appPage)).revision).toBe(before.revision + 1);
    const mouseCommit = (await state(appPage)).lastCommit;
    expect(mouseCommit?.batch.label).toMatch(/^Space on Drums, bars? /);
    await expect(appPage.getByTestId("live-region")).toHaveText(mouseCommit?.batch.label ?? "");

    const afterMouse = (await currentDoc(appPage)) as unknown as PaintDoc;
    expect(automationFor(afterMouse, "trk_drums").length).toBeGreaterThan(0);
    expect(firstRampSec(afterMouse, "trk_drums")).toBeGreaterThanOrEqual(0.05);

    // A pen stroke with varying pressure on the bass ribbon: another single commit. Playwright's
    // Firefox does not deliver synthetic pen pointer events, so that browser checks the mouse
    // path only and says so in its annotations.
    if (testInfo.project.name.startsWith("firefox")) {
      testInfo.annotations.push({
        type: "pen",
        description: "Firefox has no synthetic pen pointer events; the pen stroke was not checked",
      });
    } else {
      const beforePen = await state(appPage);
      await paintWithPen(appPage, "trk_bass", 5, 6.5);
      await expect.poll(async () => (await state(appPage)).revision).toBe(beforePen.revision + 1);
      const penCommit = (await state(appPage)).lastCommit;
      expect(penCommit?.batch.label).toMatch(/^Space on Bass, bars? /);
      const afterPen = (await currentDoc(appPage)) as unknown as PaintDoc;
      expect(automationFor(afterPen, "trk_bass").length).toBeGreaterThan(0);
      expect(firstRampSec(afterPen, "trk_bass")).toBeGreaterThanOrEqual(0.05);
    }

    // Escape cancels the stroke: no revision, no document change.
    const beforeEscape = await state(appPage);
    const docBeforeEscape = await currentDoc(appPage);
    const from = await ribbonPoint(appPage, "trk_drums", 9);
    const to = await ribbonPoint(appPage, "trk_drums", 10);
    await appPage.mouse.move(from.x, from.y);
    await appPage.mouse.down();
    await appPage.mouse.move(to.x, to.y, { steps: 4 });
    await appPage.keyboard.press("Escape");
    await appPage.mouse.up();
    await appPage.waitForTimeout(100);
    expect((await state(appPage)).revision).toBe(beforeEscape.revision);
    expect(await currentDoc(appPage)).toEqual(docBeforeEscape);

    // The palette is DOM UI: axe must stay clean with it visible.
    expect(seriousOrCritical(await new AxeBuilder({ page: appPage }).analyze())).toEqual([]);
    expect(errors).toEqual([]);
  });
});
