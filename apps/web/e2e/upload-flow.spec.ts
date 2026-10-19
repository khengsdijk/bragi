/**
 * WP-1.10: the M1 demo in a real browser against the real local backend.
 *
 *   sign in (magic link, read from Mailpit) -> pick the generated 4-minute fixture -> plain-language
 *   progress -> project -> playable canvas -> stems appear after separation and every one is
 *   soloable -> reload reopens the stored snapshot -> axe -> keyboard-only path.
 *
 * It needs the stack: `pnpm infra:up`, `pnpm dev:backend` (API on 8080, orchestrator, workers) and
 * Mailpit on 8025; Vite proxies `/v1` to the API. It is gated behind `BRAGI_E2E_STACK=1` so that
 * `pnpm test:e2e` without a stack stays green. Run it with `pnpm test:e2e:flow` (Chromium, dev
 * server). The fixture is generated (`scripts/fixture-song.mjs`); no audio is committed.
 *
 * Timings are printed as `[timing] ...` lines. They are wall clock on whatever machine this runs
 * on and are recorded in docs/wp/1.10.md with that label; they are not the 60 s reference-GPU
 * measurement.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, test } from "./app-page.js";
import { canvasPoint, layout, type ProjectLike, withHooks } from "./song-helpers.js";

const STACK = process.env.BRAGI_E2E_STACK === "1";
const MAILPIT = process.env.MAILPIT_URL ?? "http://127.0.0.1:8025";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FIXTURE_DIR = join(tmpdir(), "bragi-e2e");
const FIXTURE = join(FIXTURE_DIR, "bragi-fixture-4min.wav");

test.skip(
  !STACK,
  "needs the local backend (pnpm infra:up && pnpm dev:backend): set BRAGI_E2E_STACK=1 to run it",
);

function ensureFixture(): string {
  if (!existsSync(FIXTURE)) {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    execFileSync("node", [join(ROOT, "scripts", "fixture-song.mjs"), FIXTURE], { stdio: "ignore" });
  }
  return FIXTURE;
}

/**
 * The fixture is deterministic, so an earlier run left finished stages and cached job results for
 * the same hash. Clear them (this hash only; the uploaded object stays) so every run, and every
 * timing, is cold. `BRAGI_E2E_WARM=1` keeps them to see the cached path instead.
 */
async function resetAnalysis(file: string): Promise<void> {
  if (process.env.BRAGI_E2E_WARM === "1") return;
  const hash = `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
  // `pg` belongs to services/api, which is where it is resolved from.
  const { Pool } = createRequire(join(ROOT, "services", "api", "package.json"))("pg") as {
    Pool: new (options: {
      connectionString: string;
    }) => {
      query(sql: string, params: unknown[]): Promise<unknown>;
      end(): Promise<void>;
    };
  };
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL ?? "postgres://bragi:bragi@127.0.0.1:5432/bragi",
  });
  try {
    await pool.query(
      `DELETE FROM job_results WHERE idempotency_key IN
         (SELECT idempotency_key FROM jobs WHERE params->>'assetHash' = $1)`,
      [hash],
    );
    await pool.query("DELETE FROM analyses WHERE asset_hash = $1", [hash]);
  } finally {
    await pool.end();
  }
}

/** Requests the magic link through the UI and returns it from Mailpit. */
async function requestMagicLink(page: Page, email: string): Promise<string> {
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send me a sign-in link" }).click();
  await expect(page.getByText("Check your email for the sign-in link.")).toBeVisible();
  return magicLinkFor(email);
}

/** The magic link Mailpit received for `email`. */
async function magicLinkFor(email: string): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const listing = (await (await fetch(`${MAILPIT}/api/v1/messages?limit=50`)).json()) as {
      messages?: { ID: string; To?: { Address: string }[] }[];
    };
    const message = listing.messages?.find((m) => m.To?.some((to) => to.Address === email));
    if (message) {
      const detail = (await (await fetch(`${MAILPIT}/api/v1/message/${message.ID}`)).json()) as {
        Text?: string;
      };
      const link = /https?:\/\/\S+/.exec(detail.Text ?? "")?.[0];
      if (link) return link;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error("the magic-link email never arrived in Mailpit");
}

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto("/#/");
  const link = await requestMagicLink(page, email);
  // The link verifies the token (the API sets the session cookie) and redirects back to the app.
  await page.goto(link);
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
}

function seriousOrCritical(results: Awaited<ReturnType<AxeBuilder["analyze"]>>): string[] {
  return results.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

type TrackLike = ProjectLike["tracks"][number] & { role?: string; hidden?: boolean };

const hookDoc = (page: Page) =>
  withHooks(page, (hooks) => {
    const doc = hooks.store.store.getState().doc;
    return doc === null ? null : (JSON.parse(JSON.stringify(doc)) as ProjectLike);
  });

test.describe("upload -> live analysis -> playable, soloable canvas", () => {
  test.setTimeout(300_000);

  test("signs in, uploads the 4-minute fixture and reaches a playable canvas with soloable stems", async ({
    appPage,
  }, testInfo) => {
    const fixture = ensureFixture();
    await resetAnalysis(fixture);
    const errors: string[] = [];
    appPage.on("pageerror", (e) => errors.push(e.message));
    // Diagnostics for a red run: browser errors and failed requests land in the test output.
    let logged = 0;
    appPage.on("console", (m) => {
      if (++logged > 25) return;
      if (m.type() === "error") console.log(`[console.${m.type()}] ${m.text().slice(0, 300)}`);
    });
    appPage.on("response", (r) => {
      if (r.status() >= 400) console.log(`[http ${r.status()}] ${r.request().method()} ${r.url()}`);
    });

    await signIn(appPage, `e2e-${Date.now()}@example.test`);

    // axe on the welcome / library page (signed in, nothing uploaded yet).
    await expect(appPage.getByTestId("library-empty")).toBeVisible();
    expect(seriousOrCritical(await new AxeBuilder({ page: appPage }).analyze())).toEqual([]);

    // Pick the file; the clock starts here.
    const t0 = Date.now();
    await appPage.getByTestId("library-file").setInputFiles(fixture);

    // Plain-language progress (11 §8): no hashes, no stage ids.
    // The drop zone shows it until ingest lands, the song page after that.
    const progress = appPage
      .locator('[data-testid="library-progress"], [data-testid="analysis-progress"]')
      .first();
    await expect(progress).toBeVisible();
    const seen = new Set<string>();
    let watching = true;
    const watcher = (async () => {
      while (watching && !appPage.isClosed()) {
        const text = await progress.textContent({ timeout: 1000 }).catch(() => null);
        if (text) seen.add(text);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    })();

    // The project appears when ingest lands (the route changes to /song/<id>).
    await expect(appPage.getByTestId("project-id")).toBeVisible({ timeout: 120_000 });
    const tProject = Date.now() - t0;
    const projectId = (await appPage.getByTestId("project-id").textContent()) ?? "";
    expect(projectId).toMatch(/^prj_/);
    const workspace = appPage.getByTestId("song-workspace");
    await expect(workspace).toBeVisible({ timeout: 60_000 });
    const tCanvas = Date.now() - t0;

    // Expose the hooks for this page without leaving it (hash route only).
    await appPage.evaluate((id) => {
      window.location.hash = `#/song/${id}?e2e=1`;
    }, projectId);
    await expect
      .poll(() => withHooks(appPage, (h) => h.canvas?.stats().frames ?? 0).catch(() => 0))
      .toBeGreaterThan(0);

    // Playable: play, and the engine reports playing with an advancing playhead.
    await appPage.getByRole("button", { name: "Play" }).click();
    await expect
      .poll(
        () =>
          withHooks(appPage, (h) => {
            const s = h.controller.store.getState();
            return s.status === "error" || (s.playing && s.positionSec > 0.5)
              ? JSON.stringify({ status: s.status, error: s.error, position: s.positionSec })
              : "";
          }),
        { timeout: 60_000 },
      )
      .not.toBe("");
    const tPlaying = Date.now() - t0;
    const playState = await withHooks(appPage, (h) => h.controller.store.getState());
    expect(playState.error, JSON.stringify(playState)).toBeNull();
    expect(playState.status).toBe("ready");
    await expect(appPage.getByRole("button", { name: "Pause" })).toBeVisible();
    // Keep playing while the stems arrive: merging them must not stop the music.

    // Stems appear after separation: instrument tracks join the full-mix track.
    await expect
      .poll(async () => ((await hookDoc(appPage))?.tracks.length ?? 0) > 2, {
        timeout: 180_000,
        intervals: [500],
      })
      .toBe(true);
    const tStems = Date.now() - t0;
    const afterStems = await withHooks(appPage, (h) => h.controller.store.getState().positionSec);
    await appPage.waitForTimeout(1500);
    const later = await withHooks(appPage, (h) => {
      const state = h.controller.store.getState();
      return { playing: state.playing, positionSec: state.positionSec, status: state.status };
    });
    expect(later.playing, "playback survives the stems landing").toBe(true);
    expect(later.positionSec).toBeGreaterThan(afterStems);
    watching = false;
    await watcher;

    // The progress text was plain language.
    const all = [...seen].join(" | ");
    expect(all).not.toMatch(/sha256|asset|stage_|MODEL_ERROR|\{/i);
    console.log(`[progress] ${all}`);

    const doc = (await hookDoc(appPage)) as ProjectLike;
    const stems = (doc.tracks as TrackLike[]).filter(
      (track) => track.role !== "full_mix" && track.hidden !== true,
    );
    expect(stems.length).toBeGreaterThanOrEqual(3);
    console.log(
      `[tracks] ${JSON.stringify(doc.tracks.map((x) => [x.name, (x as TrackLike).role]))}`,
    );

    // Every stem is soloable: one track.update batch per solo, the engine and the grid follow.
    // The solo goes through the canvas ribbon's button, exactly as a user's click would.
    for (const stem of stems) {
      const tStem = Date.now();
      const lanes = await layout(appPage);
      const lane = lanes.ribbons.find((l) => l.trackId === stem.id);
      if (!lane) throw new Error(`no ribbon for ${stem.name}`);
      const before = await withHooks(appPage, (h) => h.store.store.getState().revision);
      const point = await canvasPoint(appPage, lane.solo.x + lane.solo.w / 2, lane.solo.y + 12);
      await appPage.mouse.click(point.x, point.y);
      const after = await withHooks(appPage, (h) => {
        const state = h.store.store.getState();
        return {
          revision: state.revision,
          ops: state.lastCommit?.batch.ops.map((o) => o.op),
          solo: state.doc?.tracks.filter((t) => t.solo).map((t) => t.id),
        };
      });
      expect(after.revision, `solo ${stem.name}`).toBe(before + 1);
      expect(after.ops).toEqual(["track.update"]);
      expect(after.solo).toEqual([stem.id]);
      // The accessible grid reflects it, and the engine silences everything else.
      await expect(appPage.getByTestId(`grid-solo-${stem.id}`)).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await appPage.waitForTimeout(700);
      const meters = await withHooks(appPage, (h) => h.controller.store.getState().meters);
      const others = Object.entries(meters).filter(([id]) => id !== stem.id);
      expect(
        Math.max(...others.map(([, v]) => v)),
        `others while ${stem.name} solos: ${JSON.stringify(meters)} tracks ${JSON.stringify(doc.tracks.map((x) => x.id))}`,
      ).toBeLessThan(0.001);
      console.log(`[solo] ${stem.name} ${Date.now() - tStem} ms`);
      // Un-solo again so the next stem starts from a clean mix.
      const gridSolo = appPage.getByTestId(`grid-solo-${stem.id}`);
      await gridSolo.focus();
      await appPage.keyboard.press("Enter");
      await expect(gridSolo).toHaveAttribute("aria-pressed", "false");
    }
    await appPage.getByRole("button", { name: "Pause" }).click();
    const tSoloed = Date.now() - t0;

    console.log(
      `[timing] ${testInfo.project.name}: file chosen -> project ${tProject} ms, canvas shown ${tCanvas} ms, playing ${tPlaying} ms, stems in document ${tStems} ms, every stem soloed ${tSoloed} ms`,
    );

    // Reload: the project reopens from the stored snapshot, stems included.
    await appPage.reload();
    await expect(appPage.getByTestId("song-workspace")).toBeVisible({ timeout: 60_000 });
    await expect(appPage.getByTestId("project-id")).toHaveText(projectId);
    await expect
      .poll(async () => ((await hookDoc(appPage))?.tracks.length ?? 0) === doc.tracks.length)
      .toBe(true);

    // axe on the song page.
    expect(seriousOrCritical(await new AxeBuilder({ page: appPage }).analyze())).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("sign-in and upload work with the keyboard alone", async ({ appPage }, testInfo) => {
    const fixture = ensureFixture();
    const email = `e2e-kbd-${Date.now()}@example.test`;
    await appPage.goto("/#/");
    await expect(appPage.locator("#sign-in-email")).toBeVisible();
    await appPage.locator("body").click({ position: { x: 1, y: 1 } });

    // macOS WebKit skips buttons and links on Tab unless the system setting is on; Option+Tab is
    // its "move through every control" key, and the same keyboard-only path.
    const tabKey = testInfo.project.name.startsWith("webkit") ? "Alt+Tab" : "Tab";

    /** Presses Tab until the element matching `selector` has focus (fails after 40 presses). */
    const tabTo = async (selector: string): Promise<void> => {
      for (let press = 0; press < 40; press += 1) {
        await appPage.keyboard.press(tabKey);
        if (
          await appPage.evaluate((sel) => document.activeElement?.matches(sel) ?? false, selector)
        )
          return;
      }
      throw new Error(`could not reach ${selector} with Tab`);
    };

    // Sign in: Tab to the email field, type, Tab to the button, Enter.
    await tabTo("#sign-in-email");
    await appPage.keyboard.type(email);
    await tabTo("button[type=submit]");
    await appPage.keyboard.press("Enter");
    await expect(appPage.getByText("Check your email for the sign-in link.")).toBeVisible();
    const link = await magicLinkFor(email);
    await appPage.goto(link);
    await expect(appPage.getByRole("heading", { level: 1 }).first()).toBeVisible();

    // Upload: Tab to the drop button, Enter opens the file chooser.
    await tabTo("button.library__drop");
    const chooser = appPage.waitForEvent("filechooser");
    await appPage.keyboard.press("Enter");
    await (await chooser).setFiles(fixture);
    await expect(appPage.getByTestId("project-id")).toBeVisible({ timeout: 120_000 });
    await expect(appPage.getByTestId("song-workspace")).toBeVisible({ timeout: 60_000 });

    // Play from the keyboard: Tab to the Play button and press Enter.
    await tabTo('button[aria-label="Play"]');
    await appPage.keyboard.press("Enter");
    await expect(appPage.getByRole("button", { name: "Pause" })).toBeVisible({ timeout: 30_000 });
  });
});
