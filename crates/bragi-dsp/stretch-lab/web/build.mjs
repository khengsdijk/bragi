// Builds the worklet wasm and copies it next to the page. Run: `node build.mjs`
import { execFileSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const lab = join(here, "..");
execFileSync(
  "cargo",
  ["build", "--release", "--target", "wasm32-unknown-unknown", "-p", "bragi-stretch-worklet"],
  { cwd: lab, stdio: "inherit" },
);
const wasm = join(lab, "target/wasm32-unknown-unknown/release/bragi_stretch_worklet.wasm");
copyFileSync(wasm, join(here, "bragi_stretch_worklet.wasm"));
console.log("copied bragi_stretch_worklet.wasm into web/");
