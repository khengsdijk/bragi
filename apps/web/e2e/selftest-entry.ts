/**
 * The desktop end-to-end entry point: compiled to one IIFE by
 * `e2e/selftest.vite.config.ts`, evaluated in the Tauri webview by the
 * `selftest` cargo feature, and driven in two process launches by
 * `apps/desktop/scripts/selftest.mjs`.
 *
 * It reports through `selftest_report` — granted by
 * `apps/desktop/src-tauri/capabilities/selftest.json` to the harness window only
 * — which prints the transcript and exits the process 0 or 1.
 */
import { createTauriIpc } from "@bragi/platform/tauri";

import { createDomDriver } from "./dom-driver.js";
import { assertProjectReadable, createProjectFlow } from "./scenario.js";

/** Runs the scenario half named by `phase` and reports the verdict. */
export async function main(phase: string): Promise<void> {
  const driver = createDomDriver(document);
  const report = (ok: boolean) =>
    createTauriIpc()("selftest_report", { ok, lines: [...driver.lines] });

  try {
    switch (phase) {
      case "create":
        await createProjectFlow(driver);
        break;
      case "read":
        await assertProjectReadable(driver);
        break;
      default:
        throw new Error(`unknown phase ${JSON.stringify(phase)}`);
    }
    await report(true);
  } catch (error) {
    driver.log(
      `error: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
    );
    // A rejection here would leave the harness waiting for a verdict it cannot
    // get, so report the failure and let the harness's timeout be the backstop.
    await report(false).catch((reportError: unknown) => {
      driver.log(`error: could not report the verdict: ${String(reportError)}`);
    });
  }
}
