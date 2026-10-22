/**
 * Helpers for the specs that run against the live local stack (`BRAGI_E2E_STACK=1`, single-user
 * `pnpm dev:backend`): the generated fixture, opening an uploaded song with the test hooks, and
 * waiting for its analysis to settle.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

import { type ProjectLike, withHooks } from "./song-helpers.js";

export const STACK = process.env.BRAGI_E2E_STACK === "1";
export const SKIP_REASON =
  "needs the local backend (pnpm infra:up && pnpm dev:backend): set BRAGI_E2E_STACK=1 to run it";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FIXTURE = join(tmpdir(), "bragi-e2e", "bragi-fixture-4min.wav");

/** The generated 4-minute fixture (`scripts/fixture-song.mjs`); no audio is committed. */
export function ensureFixture(): string {
  if (!existsSync(FIXTURE)) {
    mkdirSync(dirname(FIXTURE), { recursive: true });
    execFileSync("node", [join(ROOT, "scripts", "fixture-song.mjs"), FIXTURE], { stdio: "ignore" });
  }
  return FIXTURE;
}

export type TrackLike = ProjectLike["tracks"][number] & { role?: string; hidden?: boolean };

/** Tracks the accessible grid shows a row for. */
export const visible = (doc: ProjectLike | null): TrackLike[] =>
  ((doc?.tracks ?? []) as TrackLike[]).filter((track) => track.hidden !== true);

/** The live document, as plain JSON. */
export const hookDoc = (page: Page): Promise<ProjectLike | null> =>
  withHooks(page, (hooks) => {
    const doc = hooks.store.store.getState().doc;
    return doc === null ? null : (JSON.parse(JSON.stringify(doc)) as ProjectLike);
  });

/** The song's bar length in seconds and ticks, from its own tempo and meter (02 §2.2). */
export function barLengths(doc: ProjectLike): { sec: number; ticks: number } {
  const timebase = doc.arrangement.timebase;
  const bpm = timebase?.tempoMap[0]?.bpm ?? 120;
  const numerator = timebase?.timeSignatures[0]?.numerator ?? 4;
  const denominator = timebase?.timeSignatures[0]?.denominator ?? 4;
  const beatsPerBar = (4 * numerator) / denominator;
  return {
    sec: (beatsPerBar * 60) / bpm,
    ticks: Math.round((timebase?.ppq ?? 960) * beatsPerBar),
  };
}

/** The song's stem tracks: the instrument roles, without the mix-only and generated lanes. */
export function stemTracks(doc: ProjectLike): TrackLike[] {
  return visible(doc).filter(
    (track) => !["full_mix", "generated", "residual"].includes(track.role ?? ""),
  );
}

/** The slice of the history store the specs read (`window.__bragi.history`). */
interface HistoryLike {
  store: {
    getState(): {
      commits: Map<string, { id: string; parent: string | null; label: string }>;
      children: Map<string, string[]>;
      head: string | null;
    };
  };
}

export interface HistoryView {
  count: number;
  head: string | null;
  headLabel: string | null;
  root: string | null;
  rootChildren: number;
}

export const historyView = (page: Page): Promise<HistoryView> =>
  withHooks(page, (hooks) => {
    const history = (hooks as unknown as { history: HistoryLike | null }).history;
    if (history === null) throw new Error("no history store");
    const state = history.store.getState();
    const commits = [...state.commits.values()];
    const root = commits.find((commit) => commit.parent === null)?.id ?? null;
    return {
      count: commits.length,
      head: state.head,
      headLabel: state.head === null ? null : (state.commits.get(state.head)?.label ?? null),
      root,
      rootChildren: root === null ? 0 : (state.children.get(root)?.length ?? 0),
    };
  });

/**
 * Undoes back to the commit `head` (each undo moves one commit, 02 §7).
 *
 * Accepting a generated candidate starts the generated audio's own analysis, which lands about a
 * dozen system commits on top of the accepted one, some of them after the first undo: pressing
 * undo straight away would give up short of the target. So wait until the commit count has stopped
 * growing (two polls 5 s apart with the same count), then press undo until HEAD is `head`.
 */
export async function undoToHead(page: Page, head: string | null, mod: string): Promise<void> {
  let settled = -1;
  await expect
    .poll(
      async () => {
        const { count } = await historyView(page);
        const stable = count === settled;
        settled = count;
        return stable;
      },
      { timeout: 180_000, intervals: [5000] },
    )
    .toBe(true);
  await page.locator("body").click({ position: { x: 1, y: 1 } });
  for (let step = 0; step < 40; step += 1) {
    const current = await historyView(page).then((history) => history.head);
    if (current === head) break;
    await page.keyboard.press(`${mod}+z`);
    await page.waitForTimeout(400);
  }
  await expect.poll(() => historyView(page).then((history) => history.head)).toBe(head);
}

/**
 * Uploads the fixture, switches to the song page with the test hooks, and waits until the stems
 * are in the document and no analysis commit has landed for 5 s. Returns the project id.
 *
 * `onWorkspace` runs as soon as the song page shows, before the stems land: the place to press
 * Play while the engine only has the small full-mix asset to load.
 */
export async function openAnalysedSong(
  page: Page,
  onWorkspace?: () => Promise<void>,
): Promise<string> {
  await page.goto("/#/");
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
  await page.getByTestId("library-file").setInputFiles(ensureFixture());
  await expect(page.getByTestId("project-id")).toBeVisible({ timeout: 120_000 });
  const projectId = (await page.getByTestId("project-id").textContent()) ?? "";
  await page.evaluate((id) => {
    window.location.hash = `#/song/${id}?e2e=1`;
  }, projectId);
  await expect(page.getByTestId("song-workspace")).toBeVisible({ timeout: 60_000 });
  await onWorkspace?.();
  await expect
    .poll(async () => ((await hookDoc(page))?.tracks.length ?? 0) > 2, { timeout: 240_000 })
    .toBe(true);
  let settled = -1;
  await expect
    .poll(
      async () => {
        const { count } = await historyView(page);
        const stable = count === settled;
        settled = count;
        return stable;
      },
      { timeout: 120_000, intervals: [5000] },
    )
    .toBe(true);
  return projectId;
}

export function seriousOrCritical(results: Awaited<ReturnType<AxeBuilder["analyze"]>>): string[] {
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

/**
 * Whether this machine's audio output renders at all: a bare `AudioContext` with an oscillator
 * must advance its clock. When the OS output device is stuck (seen on macOS: the clock advanced
 * 5 ms in 2 s with no Bragi code on the page), no engine can play, and a spec reports that
 * instead of failing on the app.
 */
export async function audioOutputRenders(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const context = new AudioContext();
    const oscillator = new OscillatorNode(context);
    oscillator.connect(context.destination);
    oscillator.start();
    await Promise.race([
      context.resume().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
    const start = context.currentTime;
    await new Promise((resolve) => setTimeout(resolve, 600));
    const advanced = context.currentTime - start;
    void context.close();
    return advanced > 0.3;
  });
}
