/**
 * WP-2.6: the planner flow on a real song against the live local stack.
 *
 *   lasso a stem -> prompt bar with local chips -> submit -> three candidate ideas in the Audition
 *   bar -> switch 1/2/3 while playing -> Accept commits one history entry with the variant label
 *   -> undo restores the exact document -> Explain mode asks a faked planner -> popover + a canvas
 *   highlight -> axe with the prompt bar and the popover open.
 *
 * The planner is faked at the network layer (`POST /v1/plans`), so the run needs no OpenRouter key
 * and spends no credits; the song, history and audition are the real stack. Same gate as
 * `section-flow.spec.ts` (`BRAGI_E2E_STACK=1`, single-user `dev:backend`).
 */
import AxeBuilder from "@axe-core/playwright";
import type { Page, Route } from "@playwright/test";

import { expect, test } from "./app-page.js";
import { canvasPoint, layout, ribbonPoint, withHooks } from "./song-helpers.js";
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

interface DocLike {
  tracks: (NonNullable<Awaited<ReturnType<typeof hookDoc>>>["tracks"][number] & {
    role?: string;
    hidden?: boolean;
    gainDb?: number;
  })[];
  arrangement: {
    sections: { id: string; label: string; lengthTicks: number }[];
  };
}

const VARIANT_LABELS = ["Subtle", "Dusty tape", "Stripped"] as const;

/** A valid ops-only plan over the song's real track id and gain. */
function fakePlan(trackId: string, gainDb: number) {
  return {
    planId: "pln_e2eplanner000000000000",
    interpretation: "I'll make that instrument a little quieter.",
    variants: VARIANT_LABELS.map((label, index) => ({
      label,
      description: label,
      steps: [
        {
          kind: "ops",
          ops: [
            {
              op: "track.update",
              trackId,
              patch: { gainDb: Math.max(-60, gainDb - (index + 1)) },
            },
          ],
        },
      ],
    })),
    estimatedCredits: 0,
    estimatedSeconds: 0,
  };
}

function fakeExplanation(trackId: string, endTick: number) {
  return {
    text: "The drums drop out for one bar before the chorus, which makes the next part feel bigger.",
    highlights: [
      {
        region: { startTick: 0, endTick, tracks: [trackId] },
        label: "Drums",
      },
    ],
  };
}

/** One fake planner endpoint for the plan and the explain paths. */
async function fakePlanner(
  page: Page,
  trackId: string,
  gainDb: number,
  endTick: number,
): Promise<void> {
  await page.route("**/v1/plans", async (route: Route) => {
    // The app calls the API on another origin with credentials, so the fake answers the CORS
    // preflight and echoes the origin like the real server does.
    const origin = (await route.request().headerValue("origin")) ?? "*";
    const cors = {
      "access-control-allow-origin": origin,
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "content-type, authorization",
      "access-control-allow-methods": "POST, OPTIONS",
    };
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    const body = route.request().postDataJSON() as { explain?: boolean } | null;
    await route.fulfill({
      status: 200,
      headers: cors,
      contentType: "application/json",
      body: JSON.stringify(
        body?.explain === true ? fakeExplanation(trackId, endTick) : fakePlan(trackId, gainDb),
      ),
    });
  });
}

async function lasso(page: Page, trackId: string): Promise<void> {
  const from = await ribbonPoint(page, trackId, 2);
  const to = await ribbonPoint(page, trackId, 6);
  await page.locator("body").click({ position: { x: 2, y: 2 } });
  await page.keyboard.press("l");
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * step) / 8,
      from.y + (step % 2 === 0 ? 3 : -3),
    );
    await page.waitForTimeout(40);
  }
  await page.mouse.up();
}

test.describe("the planner on a real song", () => {
  test.setTimeout(300_000);

  test("lasso, prompt, three ideas, accept, undo, explain, axe", async ({ appPage }, testInfo) => {
    const errors: string[] = [];
    appPage.on("pageerror", (error) => errors.push(error.message));
    const mod = process.platform === "darwin" ? "Meta" : "Control";

    const audio = await audioOutputRenders(appPage);
    if (!audio) {
      testInfo.annotations.push({
        type: "audio",
        description: "this machine's audio output does not render: playback was not checked",
      });
    }
    await openAnalysedSong(appPage);
    const doc = (await hookDoc(appPage)) as DocLike | null;
    if (doc === null) throw new Error("no document");
    const track = visible(doc)[0];
    if (track === undefined) throw new Error("no visible instrument");
    const firstSection = doc.arrangement.sections[0];
    if (firstSection === undefined) throw new Error("no parts");
    const gainDb = (track as { gainDb?: number }).gainDb ?? 0;
    await fakePlanner(appPage, track.id, gainDb, firstSection.lengthTicks);
    const before = await hookDoc(appPage);

    await withHooks(appPage, (hooks) => {
      hooks.canvas?.fit();
      hooks.canvas?.renderNow();
    });

    await lasso(appPage, track.id);
    const prompt = appPage.getByTestId("prompt-bar");
    await expect(prompt).toBeVisible();
    await expect(appPage.getByTestId("planner-target")).not.toBeEmpty();
    await expect(prompt.getByRole("group", { name: "Suggestions" })).toBeVisible();
    await expect(
      prompt.getByRole("button", {
        name: /Half-time|More lo-fi|More reverb|Warmer|Brighter|More space|More punch|Quieter|Remove/,
      }).first(),
    ).toBeVisible();
    expect(
      await withHooks(appPage, (hooks) => hooks.canvas?.getLassoRegion() ?? null),
    ).not.toBeNull();
    expect(seriousOrCritical(await new AxeBuilder({ page: appPage }).analyze())).toEqual([]);

    await prompt.getByRole("textbox", { name: "What should change?" }).fill("make it quieter");
    await appPage.keyboard.press("Enter");
    const ideas = appPage.getByTestId("audition-bar");
    await expect(ideas).toBeVisible({ timeout: 30_000 });
    for (const label of VARIANT_LABELS) {
      await expect(ideas.getByRole("button", { name: new RegExp(label) })).toBeVisible();
    }
    await expect(appPage.getByTestId("planner-interpretation")).toContainText(
      "make that instrument a little quieter",
    );
    if (audio) {
      await expect
        .poll(() => withHooks(appPage, (hooks) => hooks.controller.store.getState().playing), {
          timeout: 30_000,
        })
        .toBe(true);
    }

    // Compare 2, 3 and 1 while the engine crossfades between their warm plans.
    await appPage.locator("body").click({ position: { x: 2, y: 2 } });
    for (const key of ["2", "3", "1"]) {
      await appPage.keyboard.press(key);
      await appPage.waitForTimeout(200);
    }
    if (audio) {
      expect(await withHooks(appPage, (hooks) => hooks.controller.store.getState().playing)).toBe(
        true,
      );
    }
    await ideas.getByRole("button", { name: /Accept/ }).click();
    await expect(ideas).toBeHidden();
    await expect.poll(async () => (await historyView(appPage)).headLabel).toBe("Subtle");

    await appPage.locator("body").click({ position: { x: 2, y: 2 } });
    await appPage.keyboard.press(`${mod}+z`);
    await expect.poll(() => hookDoc(appPage)).toEqual(before);

    // Explain mode: toggle, click a part, read the popover and see the highlight.
    await appPage.getByRole("button", { name: "Explain", exact: true }).click();
    const lanes = await layout(appPage);
    const x = lanes.gutter + 24;
    const y = lanes.sections.y + lanes.sections.h / 2;
    const point = await canvasPoint(appPage, x, y);
    const sectionId = await withHooks(
      appPage,
      (hooks, at) => hooks.canvas?.sectionAt(at.x, at.y) ?? null,
      { x, y },
    );
    expect(sectionId).not.toBeNull();
    await appPage.mouse.click(point.x, point.y);
    const popover = appPage.getByTestId("explain-popover");
    await expect(popover).toBeVisible({ timeout: 30_000 });
    await expect(appPage.getByTestId("explain-text")).toContainText("drop out for one bar");
    expect((await withHooks(appPage, (hooks) => hooks.canvas?.getHighlights() ?? [])).length).toBe(
      1,
    );
    expect(seriousOrCritical(await new AxeBuilder({ page: appPage }).analyze())).toEqual([]);
    await popover.getByRole("button", { name: "Close" }).click();
    await expect(appPage.getByTestId("explain-popover")).toBeHidden();
    await expect
      .poll(() => withHooks(appPage, (hooks) => hooks.canvas?.getHighlights() ?? []))
      .toEqual([]);

    expect(await withHooks(appPage, (hooks) => hooks.controller.store.getState().error)).toBeNull();
    console.log(
      `[planner] ${testInfo.project.name}: lasso -> 3 ideas -> accept -> undo -> explain`,
    );
    expect(errors).toEqual([]);
  });
});
