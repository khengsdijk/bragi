/**
 * The web entry point: the only place that decides *which* platform adapters the
 * app gets. It builds them with `@bragi/platform/auto` (Tauri's IPC bridge
 * present → the desktop adapters, otherwise sqlite-wasm + OPFS) and hands the
 * `Platform` to `@bragi/app`, which never learns which one it received.
 *
 * The same file and the same bundle are what the desktop app loads
 * (`apps/desktop/src-tauri/tauri.conf.json` → `frontendDist: ../../web/dist`).
 */
import { mountApp, t } from "@bragi/app";
import { createPlatform } from "@bragi/platform/auto";
import workletUrl from "@bragi/platform/engine-processor?worker&url";
import workerUrl from "@bragi/platform/engine-worker?worker&url";

import "@bragi/design/tokens.css";
import "@bragi/design/fonts.css";
import wasmUrl from "../../../crates/bragi-engine-wasm/pkg/bragi_engine_wasm_bg.wasm?url";
import { migrations } from "./migrations.js";
import "./main.css";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("index.html has no #root element");
}

document.title = t("app.name");

/** Last resort: the app could not open its storage, so say so in the page. */
function showFatalError(error: unknown): void {
  const { message } = error instanceof Error ? error : { message: String(error) };
  const paragraph = document.createElement("p");
  paragraph.dataset.testid = "fatal-error";
  paragraph.setAttribute("role", "alert");
  paragraph.textContent = `${t("projects.error")} (${message})`;
  container?.append(paragraph);
}

// The engine worklet, decoder worker and wasm are bundled by Vite, so only this file knows their
// URLs; the web adapter creates the audio engine lazily, on the first Play (a user gesture).
createPlatform({ migrations, webEngine: { workletUrl, workerUrl, wasmUrl } }).then(
  (platform) => mountApp({ platform, container }),
  (error: unknown) => showFatalError(error),
);
