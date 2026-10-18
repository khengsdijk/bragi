#!/usr/bin/env node
/**
 * Builds the wasm-bindgen package for `crates/bragi-engine-wasm`
 * (`specs/03-audio-engine.md` §3.1).
 *
 * The output lands in `crates/bragi-engine-wasm/pkg/`, which is **generated** and
 * gitignored (specs/13-agent-guide.md §1). `scripts/conformance.mjs` and the web
 * host consume it from there; there is no committed copy, so the bytes can never
 * drift from the Rust source.
 *
 *   1. `cargo build --target wasm32-unknown-unknown -p bragi-engine-wasm --release`
 *   2. `wasm-bindgen --target web --out-dir crates/bragi-engine-wasm/pkg`
 *   3. prints the raw and gzipped size (the browser has to download this file)
 *
 * Prerequisite: `wasm-bindgen` 0.2.129 on PATH, the version pinned in the root
 * `Cargo.toml` (same prerequisite as `pnpm build:model-wasm`).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const OUT_DIR = join(ROOT, "crates", "bragi-engine-wasm", "pkg");
const OUT_NAME = "bragi_engine_wasm";
const WASM = join(ROOT, "target", "wasm32-unknown-unknown", "release", `${OUT_NAME}.wasm`);

/** @param {number} bytes */
const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(3)} MiB`;

if (import.meta.url === `file://${process.argv[1]}`) {
  execFileSync(
    "cargo",
    ["build", "--target", "wasm32-unknown-unknown", "-p", "bragi-engine-wasm", "--release"],
    { cwd: ROOT, stdio: "inherit" },
  );
  execFileSync(
    "wasm-bindgen",
    ["--target", "web", "--out-dir", OUT_DIR, "--out-name", OUT_NAME, WASM],
    { cwd: ROOT, stdio: "inherit" },
  );
  const raw = statSync(join(OUT_DIR, `${OUT_NAME}_bg.wasm`)).size;
  const gzipped = gzipSync(readFileSync(join(OUT_DIR, `${OUT_NAME}_bg.wasm`))).length;
  process.stdout.write(`crates/bragi-engine-wasm/pkg: ${mib(raw)} wasm, ${mib(gzipped)} gzipped\n`);
}
