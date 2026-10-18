#!/usr/bin/env node
/**
 * The desktop end-to-end harness (WP-0.5).
 *
 * `tauri-driver` (WebDriver) supports Linux and Windows only: WKWebView has no
 * WebDriver, so on macOS the app cannot be driven from outside. Instead a
 * `selftest` cargo feature lets the app drive *itself*: this script
 *
 *   1. builds the production web bundle (the exact bundle the app ships, which is
 *      what `tauri.conf.json`'s `frontendDist` points at),
 *   2. builds the in-page driver bundle (`BragiSelftest`),
 *   3. builds the app with `--features selftest`,
 *   4. launches it twice against **one throwaway data directory**:
 *      phase `create` creates a project through the UI, phase `read` — in a new
 *      process, so the database and the blob cache are reopened from disk —
 *      reads it back and checks its stored card.
 *
 * The app reports through `selftest_report`, prints the transcript, and exits
 * 0 (pass) or 1 (fail). `BRAGI_DATA_DIR` points the app away from real user
 * data; `BRAGI_SELFTEST_PHASE` is what makes the harness window (and the
 * capability that grants the reporting command) exist at all.
 *
 * What this proves on macOS: the shipped bundle boots in WKWebView, the desktop
 * adapters are selected, the shared migrations apply through rusqlite, and a
 * project and its blob survive a full process restart. What it does not: real OS
 * input events (the driver clicks DOM controls, not the mouse) and anything on
 * Windows or Linux (see the platform table in docs/wp/0.5.md).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DRIVER = join(ROOT, "apps/web/e2e/dist/selftest.js");
const TARGET_DIR = process.env.CARGO_TARGET_DIR ?? join(ROOT, "target");
const APP = join(
  TARGET_DIR,
  "debug",
  process.platform === "win32" ? "bragi-desktop.exe" : "bragi-desktop",
);
const LAUNCH_TIMEOUT_MS = 120_000;

const PHASES = ["create", "read"];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    // pnpm and cargo are `.cmd`/`.exe` shims on Windows, which need a shell to
    // be found at all.
    shell: process.platform === "win32",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with ${result.status ?? result.signal}`);
  }
}

/** Launches the app for one phase and returns its stdout. */
function launch(phase, dataDir) {
  const result = spawnSync(APP, [], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: LAUNCH_TIMEOUT_MS,
    env: {
      ...process.env,
      BRAGI_DATA_DIR: dataDir,
      BRAGI_SELFTEST_PHASE: phase,
      BRAGI_SELFTEST_SCRIPT: DRIVER,
    },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trimEnd();
  console.log(output === "" ? `[harness] ${phase}: no output` : output);
  if (result.error) {
    throw new Error(`phase ${phase} could not run: ${result.error.message}`);
  }
  if (result.signal !== null) {
    throw new Error(`phase ${phase} was killed after ${LAUNCH_TIMEOUT_MS} ms (${result.signal})`);
  }
  if (result.status !== 0) {
    throw new Error(`phase ${phase} failed with exit code ${result.status}`);
  }
  if (!output.includes("[selftest] PASS")) {
    throw new Error(`phase ${phase} exited 0 without reporting a verdict`);
  }
}

// 1. The bundle both hosts share. `pnpm build` also builds @bragi/app and
//    @bragi/platform, which the Vite build resolves through their `dist/`.
run("pnpm", ["--filter", "@bragi/web", "run", "build"]);
// 2. The driver bundle the webview gets as a string.
run("pnpm", ["--filter", "@bragi/web", "run", "build:e2e-driver"]);
// 3. The app, with the harness compiled in.
mkdirSync(TARGET_DIR, { recursive: true });
run("cargo", [
  "build",
  "--features",
  "selftest",
  "--manifest-path",
  "apps/desktop/src-tauri/Cargo.toml",
]);

// 4. Two launches over one throwaway data directory.
const dataDir = mkdtempSync(join(tmpdir(), "bragi-selftest-"));
console.log(`[harness] data directory: ${dataDir}`);
try {
  for (const phase of PHASES) {
    console.log(`[harness] phase ${phase}`);
    launch(phase, dataDir);
  }
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}

console.log(`[harness] desktop e2e passed (${PHASES.join(" → ")}), data directory removed`);
