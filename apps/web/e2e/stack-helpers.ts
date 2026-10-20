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
 * Uploads the fixture, switches to the song page with the test hooks, and waits until the stems
 * are in the document and no analysis commit has landed for 5 s. Returns the project id.
 */
export async function openAnalysedSong(page: Page): Promise<string> {
  await page.goto("/#/");
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
  await page.getByTestId("library-file").setInputFiles(ensureFixture());
  await expect(page.getByTestId("project-id")).toBeVisible({ timeout: 120_000 });
  const projectId = (await page.getByTestId("project-id").textContent()) ?? "";
  await page.evaluate((id) => {
    window.location.hash = `#/song/${id}?e2e=1`;
  }, projectId);
  await expect(page.getByTestId("song-workspace")).toBeVisible({ timeout: 60_000 });
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
