/**
 * WP-2.8 / **M2 demo 4**: a lasso + prompt whose plan has one generative variant (06 §5; 09 §4.3).
 *
 * The planner is faked at the network layer (`POST /v1/plans`), so the run needs no OpenRouter key
 * and spends no planner credits. The faked `POST /v1/plans/{id}/execute` renders the app's uploaded
 * contexts into a **real** `generate.inpaint` job on the fake generation backend, so the generative
 * variant streams in through the same WebSocket, placement, Audition, analysis and undo paths as the
 * ops-only variants.
 *
 *   lasso -> prompt -> two instant ideas + one "generating" idea -> the generated fill lands and is
 *   accepted -> the gap's stems map onto the song's tracks -> undo restores the exact document -> axe.
 *
 * Same gate and stack as `planner-flow.spec.ts` (`BRAGI_E2E_STACK=1`, single-user `dev:backend`,
 * `BRAGI_GENERATION_BACKEND=fake`). The job's seed is fixed (7), so a repeated run is a worker
 * result-cache hit (only `job.completed`, no partials); `E2E_SEED=<n>` forces a fresh generation.
 *
 * A second mode runs against the **real** planner: `BRAGI_E2E_LIVE_PLANNER=1` skips the faked
 * `POST /v1/plans`, so the app's own requests reach the live API (`POST /v1/plans` then
 * `POST /v1/plans/{id}/execute`, which submits real jobs on the fake generation backend). It needs
 * `OPENROUTER_API_KEY` on the backend and spends planner credits. The test reads the plan from the
 * response, fails with the labels and step kinds when the planner returned no generative variant
 * (a planner-quality result the reviewer records, not a crash), and logs the interpretation, the
 * labels, the step kinds and the time to the generated candidate. Each mode skips the other.
 */
import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page, Route } from "@playwright/test";

import { expect, test } from "./app-page.js";
import { type ProjectLike, ribbonPoint, withHooks } from "./song-helpers.js";
import {
  audioOutputRenders,
  barLengths,
  historyView,
  hookDoc,
  openAnalysedSong,
  SKIP_REASON,
  STACK,
  seriousOrCritical,
  stemTracks,
  type TrackLike,
} from "./stack-helpers.js";

test.skip(!STACK, SKIP_REASON);

const PLAN_ID = "pln_e2egenerate0000000000000";
const LIVE_PLANNER = process.env.BRAGI_E2E_LIVE_PLANNER === "1";
const LIVE_SKIP_REASON =
  "needs the real planner: set BRAGI_E2E_LIVE_PLANNER=1 with OPENROUTER_API_KEY on the backend (spends planner credits)";
const FAKED_SKIP_REASON =
  "runs the faked planner: unset BRAGI_E2E_LIVE_PLANNER to run it against the live API";

/** The plan's shape as far as the live mode reads it (06 §3). */
interface PlanResponseLike {
  planId: string;
  interpretation: string;
  variants: PlanVariantLike[];
}

interface PlanVariantLike {
  label: string;
  steps: PlanStepLike[];
}

interface PlanStepLike {
  kind: string;
  id?: string;
  capability?: string;
  from?: string;
  placement?: {
    region: { startTick: number; endTick: number; tracks: string[] | "all" };
    trackId?: string;
    mode?: string;
  };
}

interface RawDoc {
  id: string;
  meta: { tags?: string[] };
  tracks: TrackLike[];
  analyses: Record<string, { summary?: { key?: string } }>;
  arrangement: {
    timebase: {
      ppq: number;
      tempoMap: { tick: number; bpm: number }[];
      timeSignatures: { bar: number; numerator: number; denominator: number }[];
    };
    sections: { id: string; lengthTicks: number }[];
  };
}

interface PlanRequestLike {
  doc: RawDoc;
  region?: { startTick: number; endTick: number; tracks: string[] | "all" };
}

interface PreparedPlan {
  request: PlanRequestLike;
  body: Record<string, unknown>;
  trackId: string;
  gap: { startTick: number; endTick: number };
  barTicks: number;
  params: Record<string, unknown>;
}

/** The analysed key as `MusicalContext.key`, from the summary line. */
function keyOf(doc: RawDoc): { tonic: string; mode: "major" | "minor" } {
  for (const ref of Object.values(doc.analyses)) {
    const text = ref.summary?.key ?? "";
    const match = /^([A-Ga-g][#b]?)\s+(major|minor)/.exec(text.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) {
      return {
        tonic: match[1].toUpperCase(),
        mode: match[2].toLowerCase() === "minor" ? "minor" : "major",
      };
    }
  }
  return { tonic: "C", mode: "major" };
}

/** The plan the fake planner answers with, from the real request. */
function planFor(request: PlanRequestLike): PreparedPlan {
  const { doc } = request;
  const timebase = doc.arrangement.timebase;
  const bpm = timebase.tempoMap[0]?.bpm ?? 120;
  const signature = timebase.timeSignatures[0] ?? { numerator: 4, denominator: 4 };
  const barTicks = Math.round((timebase.ppq * 4 * signature.numerator) / signature.denominator);
  const total = doc.arrangement.sections.reduce((sum, section) => sum + section.lengthTicks, 0);
  const region = request.region ?? { startTick: 0, endTick: total, tracks: "all" as const };
  let gapStart = Math.ceil(region.startTick / barTicks) * barTicks;
  let gapEnd = Math.floor(region.endTick / barTicks) * barTicks;
  if (gapEnd <= gapStart) {
    const middle = Math.round((region.startTick + region.endTick) / 2);
    gapStart = Math.floor(middle / barTicks) * barTicks;
    gapEnd = Math.min(total, gapStart + barTicks);
  }
  const stems = doc.tracks.filter(
    (entry) =>
      !["full_mix", "generated", "residual"].includes(entry.role ?? "") && entry.hidden !== true,
  );
  const trackId =
    region.tracks === "all" ? (stems[0]?.id ?? doc.tracks[0]?.id ?? "") : (region.tracks[0] ?? "");
  const gapBars = Math.max(1, Math.round((gapEnd - gapStart) / barTicks));
  const params = {
    gapBars,
    overlapBars: 1,
    tier: "preview",
    n: 3,
    prompt: "a short drum fill",
    context: {
      bpm,
      timeSignature: [signature.numerator, signature.denominator],
      key: keyOf(doc),
      descriptors: (doc.meta.tags ?? []).slice(0, 6),
      seed: Number(process.env.E2E_SEED ?? 7),
    },
  };
  const body = {
    planId: PLAN_ID,
    interpretation: "I'll add a generated fill, or just soften the part.",
    estimatedCredits: 2,
    estimatedSeconds: 20,
    variants: [
      {
        label: "Subtle",
        description: "A little quieter.",
        steps: [{ kind: "ops", ops: [{ op: "track.update", trackId, patch: { gainDb: -1 } }] }],
      },
      {
        label: "Generated fill",
        description: "New audio in the gap.",
        steps: [
          {
            kind: "generate",
            id: "g1",
            capability: "generate.inpaint",
            params,
            context: {
              before: { startTick: Math.max(0, gapStart - 4 * barTicks), endTick: gapStart },
              after: { startTick: gapEnd, endTick: Math.min(total, gapEnd + 4 * barTicks) },
              tracks: "all",
            },
          },
          {
            kind: "apply_generated",
            from: "g1",
            placement: {
              region: { startTick: gapStart, endTick: gapEnd, tracks: [trackId] },
              mode: "replace",
            },
          },
          {
            kind: "smooth",
            region: {
              startTick: gapEnd,
              endTick: Math.min(total, gapEnd + 2 * barTicks),
              tracks: "all",
            },
            tools: ["crossfade"],
          },
        ],
      },
      {
        label: "Stripped",
        description: "Quieter still.",
        steps: [{ kind: "ops", ops: [{ trackId, op: "track.update", patch: { gainDb: -3 } }] }],
      },
    ],
  };
  return {
    request,
    body,
    trackId,
    gap: { startTick: gapStart, endTick: gapEnd },
    barTicks,
    params,
  };
}

async function lasso(page: Page, trackId: string): Promise<void> {
  // Mid-song: a fill needs at least a bar of context plus a seam window on each side.
  const from = await ribbonPoint(page, trackId, 100);
  const to = await ribbonPoint(page, trackId, 104);
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

/** Selects a candidate by slot, accepts it, and waits for the history head to carry its label. */
async function acceptCandidate(
  page: Page,
  ideas: Locator,
  slot: number,
  label: string,
): Promise<void> {
  await page.locator("body").click({ position: { x: 2, y: 2 } });
  await page.keyboard.press(String(slot));
  await page.waitForTimeout(300);
  await ideas.getByRole("button", { name: /Accept/ }).click();
  await expect(ideas).toBeHidden();
  await expect.poll(async () => (await historyView(page)).headLabel).toBe(label);
}

/** Undoes back to the commit the run started from and checks the document is byte-for-byte it. */
async function undoTo(
  page: Page,
  before: ProjectLike | null,
  beforeHead: string | null,
  mod: string,
): Promise<void> {
  // Accepting starts the generated audio's own analysis, which lands about a dozen commits on
  // top of the accepted one; undo only once that history has stopped growing.
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
    const head = await historyView(page).then((history) => history.head);
    if (head === beforeHead) break;
    await page.keyboard.press(`${mod}+z`);
    await page.waitForTimeout(400);
  }
  await expect.poll(() => hookDoc(page), { timeout: 30_000 }).toEqual(before);
}

/**
 * Whether the placed fill's own separation maps stems into `gap` on `trackId` (02 §6.4). `null`
 * while the gap has no section yet, so `expect.poll` keeps waiting.
 */
function gapFilled(
  page: Page,
  gap: { startTick: number; endTick: number },
  trackId: string,
): () => Promise<{ onTrack: boolean; generated: boolean } | null> {
  return async () => {
    const doc = await hookDoc(page);
    if (doc === null) return null;
    let tick = 0;
    let section: ProjectLike["arrangement"]["sections"][number] | undefined;
    for (const candidate of doc.arrangement.sections) {
      if (tick + candidate.lengthTicks > gap.startTick && tick < gap.endTick) {
        section = candidate;
        break;
      }
      tick += candidate.lengthTicks;
    }
    if (section === undefined) return null;
    const roles = new Map(doc.tracks.map((entry) => [entry.id, entry.role]));
    const lanes = Object.entries(section.lanes ?? {}).filter(([, lane]) => lane.clips.length > 0);
    const onTrack = lanes.some(([laneTrack]) => laneTrack === trackId);
    const generated = lanes.some(([laneTrack]) => roles.get(laneTrack) === "generated");
    return { onTrack, generated };
  };
}

/**
 * Fakes the planner's two routes. `execute` submits a real job with the app's uploaded contexts, so
 * the generated candidate comes from the worker exactly as in production.
 */
async function fakePlanner(page: Page): Promise<{ prepared: () => PreparedPlan | null }> {
  let last: PreparedPlan | null = null;
  const cors = (route: Route): Promise<void> =>
    route.fulfill({ status: 204, headers: corsHeaders(route) });
  await page.route("**/v1/plans", async (route) => {
    if (route.request().method() === "OPTIONS") return cors(route);
    const request = route.request().postDataJSON() as PlanRequestLike;
    last = planFor(request);
    await route.fulfill({
      status: 200,
      headers: corsHeaders(route),
      contentType: "application/json",
      body: JSON.stringify(last.body),
    });
  });
  await page.route("**/v1/plans/*/execute", async (route) => {
    if (route.request().method() === "OPTIONS") return cors(route);
    const prepared = last;
    if (prepared === null) {
      await route.fulfill({ status: 500, body: "no plan" });
      return;
    }
    const body = route.request().postDataJSON() as {
      contexts?: Record<string, { before?: string; after?: string }>;
    };
    const contexts = body.contexts?.g1;
    if (contexts?.before === undefined || contexts?.after === undefined) {
      await route.fulfill({ status: 400, body: "missing contexts" });
      return;
    }
    const origin = new URL(page.url()).origin;
    const response = await page.context().request.post(`${origin}/v1/jobs`, {
      data: {
        capability: "generate.inpaint",
        priority: "interactive",
        projectId: prepared.request.doc.id,
        assets: { before: contexts.before, after: contexts.after },
        params: prepared.params,
      },
    });
    if (!response.ok()) {
      console.warn(
        `[planner-generate] job submit failed: ${response.status()} ${await response.text()}`,
      );
      await route.fulfill({ status: response.status(), body: await response.text() });
      return;
    }
    const accepted = (await response.json()) as { jobId: string };
    await route.fulfill({
      status: 200,
      headers: corsHeaders(route),
      contentType: "application/json",
      body: JSON.stringify({
        jobs: [
          {
            variant: 1,
            stepId: "g1",
            jobId: accepted.jobId,
            capability: "generate.inpaint",
            status: "queued",
            estimatedCredits: 2,
          },
        ],
      }),
    });
  });
  return { prepared: () => last };
}

function corsHeaders(route: Route): Record<string, string> {
  const origin = route.request().headers().origin ?? "*";
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  };
}

test.describe("a planner plan with a generative variant", () => {
  test.setTimeout(600_000);

  test("lasso, prompt, ops-only ideas and a generated fill, accept, undo (M2 demo 4)", async ({
    appPage,
  }, testInfo) => {
    test.skip(LIVE_PLANNER, LIVE_SKIP_REASON);
    const errors: string[] = [];
    appPage.on("pageerror", (event) => errors.push(event.message));
    const mod = process.platform === "darwin" ? "Meta" : "Control";

    const audio = await audioOutputRenders(appPage);
    if (!audio) {
      testInfo.annotations.push({
        type: "audio",
        description: "this machine's audio output does not render: playback was not checked",
      });
    }
    await openAnalysedSong(appPage);
    const before = await hookDoc(appPage);
    if (before === null) throw new Error("no document after analysis");
    const track = stemTracks(before)[0];
    if (track === undefined) throw new Error("no visible stem");
    const planner = await fakePlanner(appPage);
    const bars = barLengths(before);
    const beforeHead = (await historyView(appPage)).head;

    await withHooks(appPage, (hooks) => {
      hooks.canvas?.fit();
      hooks.canvas?.renderNow();
    });
    await lasso(appPage, track.id);
    const prompt = appPage.getByTestId("prompt-bar");
    await expect(prompt).toBeVisible();
    await expect(prompt.getByRole("group", { name: "Suggestions" })).toBeVisible();
    expect(seriousOrCritical(await new AxeBuilder({ page: appPage }).analyze())).toEqual([]);

    await prompt.getByRole("textbox", { name: "What should change?" }).fill("add a drum fill");
    await appPage.keyboard.press("Enter");

    const ideas = appPage.getByTestId("audition-bar");
    await expect(ideas).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => withHooks(appPage, (hooks) => hooks.plannerGeneration?.group() ?? null), {
        timeout: 30_000,
      })
      .toBe(PLAN_ID);
    // The two ops-only variants are instant (06 §5 step 3); the generative one is queued.
    await expect(ideas.getByRole("button", { name: /Subtle/ })).toBeVisible();
    await expect(ideas.getByRole("button", { name: /Stripped/ })).toBeVisible();
    const prepared = planner.prepared();
    if (prepared === null) throw new Error("the fake planner did not answer");

    // The generated idea streams in as the third candidate, from the real job.
    await expect
      .poll(
        () =>
          withHooks(appPage, (hooks) =>
            (hooks.audition?.store.getState().group?.candidates ?? []).map(
              (candidate: { label: string }) => candidate.label,
            ),
          ),
        { timeout: 300_000, intervals: [1_000] },
      )
      .toContain("Generated fill");
    await expect
      .poll(
        () =>
          withHooks(appPage, (hooks) => [...(hooks.audition?.store.getState().warm ?? [])].sort()),
        { timeout: 300_000, intervals: [1_000] },
      )
      .toEqual([1, 2, 3]);

    const slot = await withHooks(
      appPage,
      (hooks) =>
        hooks.audition?.store
          .getState()
          .group?.candidates.find((candidate) => candidate.label === "Generated fill")?.slot ??
        null,
    );
    if (slot === null) throw new Error("the generated idea has no slot");
    await acceptCandidate(appPage, ideas, slot, "Generated fill");
    console.log(
      `[planner-generate] ${testInfo.project.name}: accepted the generated fill in slot ${slot}`,
    );

    // The fill's own separation maps stems into the gap on the song's tracks.
    await expect
      .poll(gapFilled(appPage, prepared.gap, prepared.trackId), {
        timeout: 240_000,
        intervals: [1_000],
      })
      .toEqual({ onTrack: true, generated: false });

    // Undo returns to the document before the plan exactly.
    await undoTo(appPage, before, beforeHead, mod);

    expect(
      await withHooks(appPage, (hooks) => hooks.controller.store.getState().error),
      "the engine stayed healthy",
    ).toBeNull();
    expect(errors).toEqual([]);
    console.log(
      `[planner-generate] ${testInfo.project.name}: gap on ${prepared.trackId}, ${bars.sec.toFixed(2)} s bars`,
    );
  });

  test("a live planner plan with a generative variant (M2 demo 4, real planner)", async ({
    appPage,
  }, testInfo) => {
    test.skip(!LIVE_PLANNER, FAKED_SKIP_REASON);
    const errors: string[] = [];
    appPage.on("pageerror", (event) => errors.push(event.message));
    const mod = process.platform === "darwin" ? "Meta" : "Control";

    const audio = await audioOutputRenders(appPage);
    if (!audio) {
      testInfo.annotations.push({
        type: "audio",
        description: "this machine's audio output does not render: playback was not checked",
      });
    }
    await openAnalysedSong(appPage);
    const before = await hookDoc(appPage);
    if (before === null) throw new Error("no document after analysis");
    const track = stemTracks(before)[0];
    if (track === undefined) throw new Error("no visible stem");
    const beforeHead = (await historyView(appPage)).head;

    await withHooks(appPage, (hooks) => {
      hooks.canvas?.fit();
      hooks.canvas?.renderNow();
    });
    await lasso(appPage, track.id);
    const prompt = appPage.getByTestId("prompt-bar");
    await expect(prompt).toBeVisible();
    await expect(prompt.getByRole("group", { name: "Suggestions" })).toBeVisible();
    expect(seriousOrCritical(await new AxeBuilder({ page: appPage }).analyze())).toEqual([]);

    // The app posts the real plan request; read the plan and the lasso it answered about. Any
    // status counts: a 422 PLAN_INVALID is a planner-quality failure the reviewer records, so it
    // must surface as an error with the server's body instead of a 180 s waitForResponse timeout.
    const planResponse = appPage.waitForResponse(
      (response) =>
        response.request().method() === "POST" && new URL(response.url()).pathname === "/v1/plans",
      { timeout: 180_000 },
    );
    await prompt
      .getByRole("textbox", { name: "What should change?" })
      .fill("replace these bars with a new drum fill");
    const entered = Date.now();
    await appPage.keyboard.press("Enter");
    const response = await planResponse;
    if (response.status() !== 200) {
      throw new Error(`the live planner answered ${response.status()}: ${await response.text()}`);
    }
    const plan = (await response.json()) as PlanResponseLike;
    const planRequest = response.request().postDataJSON() as PlanRequestLike;
    console.log(
      `[planner-generate] live: interpretation="${plan.interpretation}" variants=${JSON.stringify(
        plan.variants.map((variant) => ({
          label: variant.label,
          steps: variant.steps.map((step) => step.kind),
        })),
      )}`,
    );

    // A plan without a generative idea is a planner-quality result, not a test bug: name the
    // labels and step kinds so the reviewer can record exactly what came back. Checked before the
    // group poll: an ops-only plan never queues a generation, so that poll would only time out
    // with `null` and hide the planner's actual answer.
    const generative = plan.variants.find((variant) =>
      variant.steps.some((step) => step.kind === "generate"),
    );
    if (generative === undefined) {
      const described = plan.variants
        .map(
          (variant) => `"${variant.label}" [${variant.steps.map((step) => step.kind).join(", ")}]`,
        )
        .join("; ");
      throw new Error(
        `the live planner returned no variant with a generate step for "replace these bars with a new drum fill": ${described}`,
      );
    }
    const generateStep = generative.steps.find((step) => step.kind === "generate");
    const applyStep = generative.steps.find((step) => step.kind === "apply_generated");

    const ideas = appPage.getByTestId("audition-bar");
    await expect(ideas).toBeVisible({ timeout: 60_000 });
    await expect
      .poll(() => withHooks(appPage, (hooks) => hooks.plannerGeneration?.group() ?? null), {
        timeout: 60_000,
      })
      .toBe(plan.planId);

    // The ops-only variants are instant (06 §5 step 3); the generative one is queued.
    for (const variant of plan.variants) {
      if (variant.steps.some((step) => step.kind === "generate")) continue;
      await expect(ideas.getByRole("button", { name: variant.label })).toBeVisible();
    }

    // The generated idea streams in as a candidate, from the real job.
    await expect
      .poll(
        () =>
          withHooks(appPage, (hooks) =>
            (hooks.audition?.store.getState().group?.candidates ?? []).map(
              (candidate: { label: string }) => candidate.label,
            ),
          ),
        { timeout: 300_000, intervals: [1_000] },
      )
      .toContain(generative.label);
    console.log(
      `[planner-generate] live: "${generative.label}" arrived ${((Date.now() - entered) / 1000).toFixed(1)} s after Enter`,
    );

    const slot = await withHooks(
      appPage,
      // The callback runs in the page, so the label travels as its argument.
      (hooks, label) =>
        hooks.audition?.store
          .getState()
          .group?.candidates.find((candidate) => candidate.label === label)?.slot ?? null,
      generative.label,
    );
    if (slot === null) throw new Error("the generated idea has no slot");
    await acceptCandidate(appPage, ideas, slot, generative.label);
    console.log(
      `[planner-generate] live: accepted "${generative.label}" in slot ${slot} (${generateStep?.capability ?? "?"})`,
    );

    // The gap's stems map onto the song's tracks only when the plan inpainting the lasso; the
    // model may choose an extend or a transition instead, so the check follows the placement.
    const placementRegion = applyStep?.placement?.region;
    const lassoRegion = planRequest.region;
    const lassoTrack =
      lassoRegion !== undefined && Array.isArray(lassoRegion.tracks)
        ? lassoRegion.tracks[0]
        : undefined;
    const checkTrack =
      placementRegion !== undefined && Array.isArray(placementRegion.tracks)
        ? (placementRegion.tracks[0] ?? applyStep?.placement?.trackId ?? lassoTrack)
        : (applyStep?.placement?.trackId ?? lassoTrack);
    const inpaintsLasso =
      generateStep?.capability === "generate.inpaint" &&
      lassoRegion !== undefined &&
      placementRegion !== undefined &&
      placementRegion.startTick >= lassoRegion.startTick &&
      placementRegion.endTick <= lassoRegion.endTick;
    if (inpaintsLasso && placementRegion !== undefined && checkTrack !== undefined) {
      await expect
        .poll(gapFilled(appPage, placementRegion, checkTrack), {
          timeout: 240_000,
          intervals: [1_000],
        })
        .toEqual({ onTrack: true, generated: false });
    } else {
      console.log(
        `[planner-generate] live: skipped the gap's stems check (capability ${
          generateStep?.capability ?? "none"
        }, placement ${
          placementRegion === undefined
            ? "none"
            : `${placementRegion.startTick}-${placementRegion.endTick}`
        } vs lasso ${
          lassoRegion === undefined ? "none" : `${lassoRegion.startTick}-${lassoRegion.endTick}`
        })`,
      );
    }

    // Undo returns to the document before the plan exactly.
    await undoTo(appPage, before, beforeHead, mod);

    expect(
      await withHooks(appPage, (hooks) => hooks.controller.store.getState().error),
      "the engine stayed healthy",
    ).toBeNull();
    expect(errors).toEqual([]);
  });
});
