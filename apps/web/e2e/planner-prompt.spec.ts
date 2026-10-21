/**
 * WP-2.6: the prompt bar on the demo page, with the planner faked at the network layer.
 *
 * No stack and no OpenRouter key: the demo has a document and analysis but no version tree, so
 * the request is made and the interpretation is shown, then the bar says candidates need a saved
 * project. This keeps the prompt bar, chips, busy/error copy and axe covered in every browser by
 * `pnpm test:e2e`; the full candidate flow needs the live stack (`planner-flow.spec.ts`).
 */
import AxeBuilder from "@axe-core/playwright";

import { expect, test } from "./app-page.js";
import { openDemo } from "./song-helpers.js";
import { seriousOrCritical } from "./stack-helpers.js";

const PLAN = {
  planId: "pln_e2edemo00000000000000",
  interpretation: "I'll warm up the whole song a little.",
  variants: [
    {
      label: "Warm",
      description: "A gentle lift in warmth.",
      steps: [
        {
          kind: "ops",
          ops: [
            {
              op: "track.update",
              trackId: "trk_bass",
              patch: { gainDb: -1 },
            },
          ],
        },
      ],
    },
  ],
  estimatedCredits: 0,
  estimatedSeconds: 0,
};

test.describe("the prompt bar on the demo", () => {
  test("opens on the whole song, asks the faked planner and shows the result", async ({
    appPage,
  }) => {
    await openDemo(appPage, { audio: false });
    await appPage.route("**/v1/plans", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(PLAN),
      });
    });

    await appPage.getByRole("button", { name: "Ask AI…" }).click();
    const prompt = appPage.getByTestId("prompt-bar");
    await expect(prompt).toBeVisible();
    await expect(appPage.getByTestId("planner-target")).toHaveText("Whole song");
    await expect(prompt.getByRole("group", { name: "Suggestions" })).toBeVisible();
    expect(seriousOrCritical(await new AxeBuilder({ page: appPage }).analyze())).toEqual([]);

    await prompt.getByRole("textbox", { name: "What should change?" }).fill("make it warmer");
    await appPage.keyboard.press("Enter");
    await expect(appPage.getByTestId("planner-interpretation")).toContainText("warm up");
    await expect(appPage.getByTestId("planner-message")).toHaveText(
      "Version ideas need a saved project.",
    );

    // Escape closes the bar and puts the prompt away without touching the song.
    await appPage.keyboard.press("Escape");
    await expect(prompt).toBeHidden();
  });
});
