/**
 * WP-1.9 web end-to-end: the Song Canvas in every browser project.
 *
 * Covers what a unit test cannot: that Pixi really draws (backend read-back), that the accessible
 * grid and the canvas agree, that gestures on the canvas become one op batch, that the selection
 * lives in the URL, and that axe finds nothing serious. Audio is in `song-audio.spec.ts`, the
 * pixel comparison in `canvas-visual.spec.ts`, the budgets in `canvas-perf.spec.ts`.
 */
import AxeBuilder from "@axe-core/playwright";

import { expect, test } from "./app-page.js";
import {
  canvasPoint,
  currentDoc,
  layout,
  openDemo,
  waitForFrame,
  withHooks,
} from "./song-helpers.js";

test("draws the demo song and exposes its layout as an accessible grid", async ({ appPage }) => {
  await openDemo(appPage, { audio: false });
  const renderer = await withHooks(appPage, (h) => h.canvas?.rendererName ?? "none");
  console.log(`[e2e] renderer: ${renderer}`);
  expect(["webgl", "webgpu"]).toContain(renderer);

  // Something was really drawn: a non-blank read-back where the backend allows one.
  const coverage = await withHooks(appPage, (h) => h.canvas?.coverage() ?? null);
  if (coverage !== null) expect(coverage).toBeGreaterThan(0.1);

  const grid = appPage.getByRole("grid", { name: "Song layout" });
  await expect(grid).toBeAttached();
  await expect(grid.getByRole("columnheader")).toHaveCount(6);
  await expect(grid.getByRole("row")).toHaveCount(7);
});

test("passes axe with no serious or critical issues", async ({ appPage }) => {
  await openDemo(appPage, { audio: false });
  const results = await new AxeBuilder({ page: appPage }).analyze();
  const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual(
    [],
  );
});

test("the Inspector passes axe with a track selected", async ({ appPage }) => {
  await openDemo(appPage, { audio: false });
  const firstCell = appPage.locator('[data-testid="song-grid"] td[tabindex="0"]');
  await firstCell.focus();
  await appPage.keyboard.press("ArrowDown"); // chords row
  await appPage.keyboard.press("ArrowDown"); // drums
  await appPage.keyboard.press("Enter");
  await expect(appPage.getByTestId("inspector-panel")).toBeVisible();
  await appPage.getByRole("button", { name: "Expert" }).click();
  const results = await new AxeBuilder({ page: appPage }).analyze();
  const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(bad.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual(
    [],
  );
});

test("is reachable and operable by keyboard alone", async ({ appPage }) => {
  await openDemo(appPage, { audio: false });
  const before = await currentDoc(appPage);

  // Tab into the grid (one tab stop), move to the Bass row and mute it with M.
  const firstCell = appPage.locator('[data-testid="song-grid"] td[tabindex="0"]');
  await firstCell.focus();
  await appPage.keyboard.press("ArrowDown"); // chords row
  await appPage.keyboard.press("ArrowDown"); // drums
  await appPage.keyboard.press("ArrowDown"); // bass
  await appPage.keyboard.press("m");
  await expect(appPage.getByTestId("live-region")).toHaveText("Mute Bass");
  expect((await currentDoc(appPage)).tracks.find((t) => t.id === "trk_bass")?.mute).toBe(true);
  await appPage.keyboard.press("o");
  expect((await currentDoc(appPage)).tracks.find((t) => t.id === "trk_bass")?.solo).toBe(true);
  await appPage.keyboard.press("m");
  await appPage.keyboard.press("o");
  expect(await currentDoc(appPage)).toEqual(before);

  // Enter selects the instrument and puts it in the URL; Escape clears it.
  await appPage.keyboard.press("Enter");
  await expect(appPage.getByTestId("selection-summary")).toHaveText("1 instruments selected");
  expect(appPage.url()).toContain("sel=t%3Atrk_bass");
  await appPage.keyboard.press("Escape");
  await expect(appPage.getByTestId("selection-summary")).toHaveText("Whole song");
  expect(appPage.url()).not.toContain("sel=");

  // The transport bar is plain buttons: reachable by Tab with visible names.
  await expect(appPage.getByRole("button", { name: "Play" })).toBeVisible();
  await expect(appPage.getByRole("button", { name: "Back to start" })).toBeVisible();
  await expect(appPage.getByRole("slider", { name: "Position" })).toBeVisible();
});

test("section actions work from the keyboard, the menu and the command palette", async ({
  appPage,
}) => {
  await openDemo(appPage, { audio: false });
  const before = await currentDoc(appPage);
  const ids = before.arrangement.sections.map((section) => section.id);

  // Once a part is selected, Alt+→ moves it one place and announces the result.
  const first = appPage.locator('[data-testid="song-grid"] td[tabindex="0"]');
  await first.focus();
  await appPage.keyboard.press("Enter");
  await expect(appPage.getByTestId("selection-summary")).toHaveText("1 parts selected");
  await appPage.keyboard.press("Alt+ArrowRight");
  await expect(appPage.getByTestId("live-region")).toHaveText("Intro moved after Verse 1");
  expect((await currentDoc(appPage)).arrangement.sections.map((section) => section.id)).toEqual([
    ids[1],
    ids[0],
    ...ids.slice(2),
  ]);
  // One commit; the demo has no version tree, so the other direction restores the arrangement.
  expect(await withHooks(appPage, (h) => h.store.store.getState().lastCommit?.batch.label)).toBe(
    "Move Intro after Verse 1",
  );
  await appPage.keyboard.press("Alt+ArrowLeft");
  await expect
    .poll(async () => (await currentDoc(appPage)).arrangement.sections.map((section) => section.id))
    .toEqual(ids);

  // Shift+F10 on the focused cell opens the same accessible menu; Escape returns focus.
  await first.focus();
  await appPage.keyboard.press("Shift+F10");
  const menu = appPage.getByRole("menu", { name: "Part actions" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Duplicate part" })).toBeVisible();
  await appPage.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect
    .poll(async () => appPage.evaluate(() => document.activeElement?.getAttribute("role")))
    .toBe("gridcell");

  // A menu item commits its batch and announces it.
  await appPage.keyboard.press("Shift+F10");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Duplicate part" }).click();
  await expect(appPage.getByTestId("live-region")).toHaveText("Duplicated Intro");
  expect((await currentDoc(appPage)).arrangement.sections).toHaveLength(ids.length + 1);

  // Cmd/Ctrl+K opens the palette; Enter runs the filtered command.
  await expect
    .poll(async () => appPage.evaluate(() => document.activeElement?.getAttribute("role")))
    .toBe("gridcell");
  await appPage.keyboard.press("Control+k");
  const palette = appPage.getByRole("dialog", { name: "Commands" });
  await expect(palette).toBeVisible();
  await appPage.getByRole("combobox").fill("duplicate");
  await expect(appPage.getByRole("option", { name: /Duplicate part/ })).toBeVisible();
  await appPage.keyboard.press("Enter");
  await expect(palette).toBeHidden();
  await expect(appPage.getByTestId("live-region")).toHaveText("Duplicated Intro");
  expect((await currentDoc(appPage)).arrangement.sections).toHaveLength(ids.length + 2);
});

test("the section menu and command palette pass axe", async ({ appPage }) => {
  await openDemo(appPage, { audio: false });
  await appPage.locator('[data-testid="song-grid"] td[tabindex="0"]').focus();
  await appPage.keyboard.press("Shift+F10");
  await expect(appPage.getByRole("menu", { name: "Part actions" })).toBeVisible();
  const menuResults = await new AxeBuilder({ page: appPage }).analyze();
  const menuBad = menuResults.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  expect(
    menuBad.map((v) => `${v.id}: ${v.nodes.map((node) => node.target.join(" ")).join(", ")}`),
  ).toEqual([]);
  await appPage.keyboard.press("Escape");
  await expect(appPage.getByRole("menu", { name: "Part actions" })).toBeHidden();

  await appPage.keyboard.press("Control+k");
  await expect(appPage.getByRole("dialog", { name: "Commands" })).toBeVisible();
  const paletteResults = await new AxeBuilder({ page: appPage }).analyze();
  const paletteBad = paletteResults.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  expect(
    paletteBad.map((v) => `${v.id}: ${v.nodes.map((node) => node.target.join(" ")).join(", ")}`),
  ).toEqual([]);
});

test("solo and mute pressed on a ribbon commit one op batch and undo exactly", async ({
  appPage,
}) => {
  await openDemo(appPage, { audio: false });
  const before = await currentDoc(appPage);
  const lanes = await layout(appPage);
  const drums = lanes.ribbons.find((lane) => lane.trackId === "trk_drums");
  if (!drums) throw new Error("no drums lane");

  const mute = await canvasPoint(appPage, drums.mute.x + drums.mute.w / 2, drums.mute.y + 12);
  await appPage.mouse.click(mute.x, mute.y);
  const commit = await withHooks(appPage, (h) => h.store.store.getState().lastCommit);
  expect(commit?.batch.label).toBe("Mute Drums");
  expect(commit?.batch.ops).toHaveLength(1);
  expect(commit?.batch.ops[0]?.op).toBe("track.update");
  expect((await currentDoc(appPage)).tracks.find((t) => t.id === "trk_drums")?.mute).toBe(true);
  expect(await withHooks(appPage, (h) => h.store.store.getState().revision)).toBe(2);

  const solo = await canvasPoint(appPage, drums.solo.x + drums.solo.w / 2, drums.solo.y + 12);
  await appPage.mouse.click(solo.x, solo.y);
  expect((await currentDoc(appPage)).tracks.find((t) => t.id === "trk_drums")?.solo).toBe(true);

  // Undo = pressing both again; the document returns deep-equal (02 §10 check 1's spirit).
  await appPage.mouse.click(mute.x, mute.y);
  await appPage.mouse.click(solo.x, solo.y);
  expect(await currentDoc(appPage)).toEqual(before);
  // The grid followed the document.
  await expect(appPage.getByTestId("grid-mute-trk_drums")).toHaveAttribute("aria-pressed", "false");
});

test("selecting a part on the canvas writes it to the URL and survives a reload", async ({
  appPage,
}) => {
  await openDemo(appPage, { audio: false });
  const lanes = await layout(appPage);
  const viewport = await withHooks(appPage, (h) => h.canvas?.getViewport() ?? null);
  if (!viewport) throw new Error("no viewport");
  // The middle of Chorus 1 (12 s to 20 s at 120 BPM).
  const pxPerSec = (viewport.pxPerBeat * 120) / 60;
  const x = lanes.gutter + (16 - viewport.originSec) * pxPerSec;
  const point = await canvasPoint(appPage, x, lanes.sections.y + lanes.sections.h / 2);
  await appPage.mouse.click(point.x, point.y);
  await expect(appPage.getByTestId("selection-summary")).toHaveText("1 parts selected");
  expect(decodeURIComponent(appPage.url())).toContain("sel=s:sec_002");

  await appPage.reload();
  await waitForFrame(appPage);
  await expect(appPage.getByTestId("selection-summary")).toHaveText("1 parts selected");
  await expect(
    appPage.locator('[data-row-kind="layout"] td[aria-selected="true"]'),
  ).toHaveAttribute("data-section-id", "sec_002");
});

test("zooms through the four levels and the lanes grow at the Moment level", async ({
  appPage,
}) => {
  await openDemo(appPage, { audio: false });
  const level = appPage.getByTestId("zoom-level");
  await expect(level).toHaveText("Song");
  const seen = new Set<string>();
  for (let i = 0; i < 12; i += 1) {
    await appPage.getByRole("button", { name: "Zoom in" }).click();
    seen.add((await level.textContent()) ?? "");
  }
  expect([...seen]).toEqual(expect.arrayContaining(["Close", "Moment"]));
  const heights = await withHooks(appPage, (h) => h.canvas?.getLayout().ribbons[0]?.rect.h ?? 0);
  expect(heights).toBe(72);
  await appPage.getByRole("button", { name: "Zoom out" }).click({ clickCount: 12 });
  await appPage.getByRole("button", { name: "Fit song" }).click();
  await expect(level).toHaveText("Song");
});

test("shows a single block and one mix ribbon until the analysis has arrived", async ({
  appPage,
}) => {
  await openDemo(appPage, { audio: false, stages: "ingest,rhythm" });
  const states = await withHooks(appPage, (h) => h.canvas?.layerStates() ?? null);
  expect(states).toEqual({
    grid: "live",
    skyline: "pending",
    sections: "pending",
    stems: "pending",
    harmony: "pending",
  });
  const grid = appPage.getByRole("grid", { name: "Song layout" });
  await expect(grid.getByRole("columnheader")).toHaveCount(2);
  await expect(grid.locator('[data-row-kind="instrument"]')).toHaveCount(1);

  await appPage.goto("/favicon.svg");
  await openDemo(appPage, { audio: false });
  expect(await withHooks(appPage, (h) => h.canvas?.layerStates() ?? null)).toEqual({
    grid: "live",
    skyline: "live",
    sections: "live",
    stems: "live",
    harmony: "live",
  });
});
