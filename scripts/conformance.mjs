#!/usr/bin/env node
/**
 * The engine conformance harness (`specs/03-audio-engine.md` §11,
 * `specs/13-agent-guide.md` §6): renders golden fixtures three ways and nulls
 * them against each other.
 *
 *     native binary  ─┐
 *     WASM in Node   ─┼─  pairwise null ≤ −90 dBFS
 *     golden WAV     ─┘
 *
 * Usage:
 *   node scripts/conformance.mjs            # verify against the committed goldens
 *   node scripts/conformance.mjs --update   # rewrite the goldens from the native render
 *   node scripts/conformance.mjs --no-build # reuse the last builds
 *
 * The fixtures are generated audio (fixtures/audio/SOURCE.txt); no
 * copyrighted content is involved.
 */
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { OUT_DIR } from "./build-engine-wasm.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const UPDATE = process.argv.includes("--update");
const BUILD = !process.argv.includes("--no-build");
/** The acceptance threshold from specs/12-roadmap.md WP-1.1. */
const NULL_TARGET_DB = -90.0;

const DRUMS = "sha256:1b77ad128280974bbacf069084b80098f0561361a2b76e852ced984779a64900";
const TONE = "sha256:4f0f99f60f5a81427887a233bacd5bbca2e0f7e4fe4f18ce1c39904955362f3e";

const FIXTURES = [
  {
    name: "engine-conformance-a",
    project: "fixtures/projects/engine-conformance-a.json",
    frames: 96000,
    assets: [
      { hash: DRUMS, path: "fixtures/audio/drums_120.wav", mime: "audio/wav" },
      { hash: TONE, path: "fixtures/audio/tone_440.wav", mime: "audio/wav" },
    ],
    gate: true,
  },
  {
    name: "engine-conformance-b",
    project: "fixtures/projects/engine-conformance-b.json",
    frames: 48000,
    assets: [{ hash: TONE, path: "fixtures/audio/tone_440.wav", mime: "audio/wav" }],
    gate: true,
  },
  {
    // The phase vocoder uses libm trig, whose last bits differ between native
    // and wasm32, so this fixture is reported but not gated (Q31). Everything
    // else about it — plan, transport, gain, fades — is still compared.
    name: "engine-conformance-c-stretch",
    project: "fixtures/projects/engine-conformance-c.json",
    frames: 48000,
    assets: [{ hash: TONE, path: "fixtures/audio/tone_440.wav", mime: "audio/wav" }],
    gate: false,
  },
  {
    // WP-2.3: a `gain` on a track and on the master, so the WASM/native null
    // test covers the fx chain path (plan → live effects → master fx → limiter).
    name: "engine-conformance-d-fx",
    project: "fixtures/projects/engine-conformance-fx.json",
    frames: 48000,
    assets: [{ hash: TONE, path: "fixtures/audio/tone_440.wav", mime: "audio/wav" }],
    gate: true,
  },
  {
    // WP-2.2: four sections whose source windows are reordered, so every
    // boundary is discontinuous. Three cut transitions (5 ms) and one 1/4-beat
    // crossfade exercise the pre/post-roll gains in both engines.
    name: "engine-conformance-e-boundaries",
    project: "fixtures/projects/engine-conformance-e-boundaries.json",
    frames: 96000,
    assets: [
      { hash: DRUMS, path: "fixtures/audio/drums_120.wav", mime: "audio/wav" },
      { hash: TONE, path: "fixtures/audio/tone_440.wav", mime: "audio/wav" },
    ],
    gate: true,
  },
  {
    // WP-2.5: fixture a with three warm candidates (other gains, a muted track)
    // and audition switches at fixed samples, one of them inside a running
    // 30 ms crossfade, so both hosts run the same slot crossfades.
    name: "engine-conformance-f-audition",
    project: "fixtures/projects/engine-conformance-a.json",
    frames: 96000,
    assets: [
      { hash: DRUMS, path: "fixtures/audio/drums_120.wav", mime: "audio/wav" },
      { hash: TONE, path: "fixtures/audio/tone_440.wav", mime: "audio/wav" },
    ],
    warm: [
      { slot: 1, gains: { trk_drums: -6, trk_tone: 0 } },
      { slot: 2, mute: "trk_drums" },
      { slot: 3, mute: "trk_tone" },
    ],
    switches: [
      { at: 12000, slot: 1 },
      { at: 30000, slot: 2 },
      { at: 30480, slot: 3 },
      { at: 60000, slot: 0 },
    ],
    gate: true,
  },
];

const GOLDEN_DIR = join(ROOT, "fixtures", "audio", "golden");
const work = mkdtempSync(join(tmpdir(), "bragi-conformance-"));

/**
 * @param {string} command
 * @param {string[]} args
 * @param {import("node:child_process").ExecFileSyncOptions} [options]
 */
function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: ROOT, encoding: "utf8", ...options });
}

/**
 * Parses the project's 32-bit-float WAV format
 * (crates/bragi-engine-native/src/wav.rs).
 * @param {string} path
 */
function readF32Wav(path) {
  const bytes = readFileSync(path);
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error(`${path}: not a WAV`);
  }
  let offset = 12;
  let channels = 1;
  let sampleRate = 48000;
  let format = 1;
  let bits = 16;
  let data = null;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      format = bytes.readUInt16LE(body);
      channels = bytes.readUInt16LE(body + 2);
      sampleRate = bytes.readUInt32LE(body + 4);
      bits = bytes.readUInt16LE(body + 14);
    } else if (id === "data") {
      data = bytes.subarray(body, Math.min(body + size, bytes.length));
    }
    offset = body + size + (size % 2);
  }
  if (!data) throw new Error(`${path}: no data chunk`);
  if (format !== 3 || bits !== 32) throw new Error(`${path}: expected 32-bit float`);
  const samples = new Float32Array(
    data.buffer.slice(data.byteOffset, data.byteOffset + data.length),
  );
  return { samples, channels, sampleRate };
}

/**
 * RMS of the sample difference, in dBFS. −Infinity means identical.
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 */
function nullLevelDb(a, b) {
  const len = Math.min(a.length, b.length);
  if (len === 0) return Number.NEGATIVE_INFINITY;
  let sum = 0;
  for (let index = 0; index < len; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    sum += diff * diff;
  }
  const rms = Math.sqrt(sum / len);
  return rms === 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(rms);
}

/** @returns {Promise<Record<string, unknown>>} */
async function loadWasm() {
  const module = await import(pathToFileURL(join(OUT_DIR, "bragi_engine_wasm.js")).href);
  module.initSync({ module: readFileSync(join(OUT_DIR, "bragi_engine_wasm_bg.wasm")) });
  return module;
}

/**
 * The candidate documents of a switch fixture: the base project with other
 * track gains or one track muted.
 * @param {typeof FIXTURES[number]} fixture
 * @returns {{ slot: number, json: string }[]}
 */
function warmDocs(fixture) {
  return (fixture.warm ?? []).map((candidate) => {
    const doc = JSON.parse(readFileSync(join(ROOT, fixture.project), "utf8"));
    /** @type {Record<string, number>} */
    const gains = candidate.gains ?? {};
    for (const track of doc.tracks) {
      const gain = gains[track.id];
      if (gain !== undefined) track.gainDb = gain;
      if (candidate.mute === track.id) track.mute = true;
    }
    return { slot: candidate.slot, json: JSON.stringify(doc) };
  });
}

/**
 * @param {any} module
 * @param {typeof FIXTURES[number]} fixture
 */
async function renderWasm(module, fixture) {
  const engine = new module.EngineWasm(512);
  for (const asset of fixture.assets) {
    const bytes = new Uint8Array(readFileSync(join(ROOT, asset.path)));
    engine.add_asset(asset.hash, bytes, asset.mime);
  }
  const json = readFileSync(join(ROOT, fixture.project), "utf8");
  engine.load_project(json);
  if (fixture.switches) {
    for (const { slot, json: candidate } of warmDocs(fixture)) {
      if (!engine.warm_project(slot, candidate)) throw new Error(`could not warm slot ${slot}`);
    }
    const at = Float64Array.from(fixture.switches.map((entry) => entry.at));
    const slots = Uint32Array.from(fixture.switches.map((entry) => entry.slot));
    return Float32Array.from(engine.render_switching(0n, BigInt(fixture.frames), 512, at, slots));
  }
  const samples = engine.render(0n, BigInt(fixture.frames), 512);
  return Float32Array.from(samples);
}

/**
 * @param {typeof FIXTURES[number]} fixture
 * @param {string} outWav
 * @param {string} outRaw
 */
function renderNative(fixture, outWav, outRaw) {
  const args = [
    "run",
    "--quiet",
    "-p",
    "bragi-engine-native",
    "--bin",
    "bragi-render",
    "--",
    "--project",
    join(ROOT, fixture.project),
    "--frames",
    String(fixture.frames),
    "--out",
    outWav,
    "--raw",
    outRaw,
  ];
  for (const asset of fixture.assets) {
    args.push("--asset", `${asset.hash}=${join(ROOT, asset.path)}`);
  }
  for (const { slot, json } of warmDocs(fixture)) {
    const path = join(work, `${fixture.name}.warm${slot}.json`);
    writeFileSync(path, json);
    args.push("--warm", `${slot}=${path}`);
  }
  for (const { at, slot } of fixture.switches ?? []) {
    args.push("--switch", `${at}=${slot === 0 ? "main" : slot}`);
  }
  const output = String(run("cargo", args));
  const sha = /^sha256:([0-9a-f]{64})$/m.exec(output)?.[1];
  if (!sha) throw new Error(`native render printed no sha:\n${output}`);
  const raw = readFileSync(outRaw);
  return {
    samples: new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length)),
    sha,
  };
}

/**
 * The export jobs run through both hosts on the gated fixtures (WP-1.11).
 * The same Rust encoders produce the files, so native and WASM must agree.
 */
const EXPORT_JOBS = [
  { name: "mixdown-wav24", job: { kind: "mixdown", format: { container: "wav", bits: 24 } } },
  { name: "mixdown-wav32", job: { kind: "mixdown", format: { container: "wav", bits: 32 } } },
  { name: "mixdown-flac24", job: { kind: "mixdown", format: { container: "flac", bits: 24 } } },
  {
    name: "stems-wav24",
    job: { kind: "stems", tracks: "all", format: { container: "wav", bits: 24 } },
  },
  // WP-2.7: a non-zero start exercises the tick -> sample conversion and the
  // rendered pre-roll; the file is always 32-bit float `context.wav`.
  {
    name: "context-wav32",
    job: { kind: "context", range: { startTick: 480, endTick: 960 }, tracks: "all" },
  },
];

/**
 * Reads an export frame (bragi_engine::export::ExportResult::to_frame).
 * @param {Uint8Array} frame
 * @returns {{ name: string, bytes: Buffer }[]}
 */
function readExportFrame(frame) {
  const buffer = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
  if (buffer.toString("ascii", 0, 4) !== "BXPT") throw new Error("not an export frame");
  const jsonLength = buffer.readUInt32LE(4);
  const header = JSON.parse(buffer.toString("utf8", 8, 8 + jsonLength));
  let offset = 8 + jsonLength;
  return header.files.map((/** @type {{ name: string, length: number }} */ entry) => {
    const bytes = buffer.subarray(offset, offset + entry.length);
    offset += entry.length;
    return { name: entry.name, bytes };
  });
}

/**
 * Decodes a PCM or float WAV to f32, whatever its bit depth.
 * @param {Buffer} bytes
 */
function decodeWav(bytes) {
  let offset = 12;
  let format = 1;
  let bits = 16;
  let data = null;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      format = bytes.readUInt16LE(body);
      bits = bytes.readUInt16LE(body + 14);
    } else if (id === "data") {
      data = bytes.subarray(body, body + size);
    }
    offset = body + size + (size % 2);
  }
  if (!data) throw new Error("no data chunk");
  const count = data.length / (bits / 8);
  const out = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    if (format === 3) out[index] = data.readFloatLE(index * 4);
    else if (bits === 24) out[index] = data.readIntLE(index * 3, 3) / 8388608;
    else out[index] = data.readInt16LE(index * 2) / 32768;
  }
  return out;
}

/**
 * Runs the export jobs through native and WASM and compares the files.
 * WAV is gated on the decoded null (the encoders are shared, so the only
 * possible difference is a last-bit render difference crossing a rounding
 * boundary); FLAC is reported as byte-identical or not.
 * @param {any} wasmModule
 * @param {typeof FIXTURES[number]} fixture
 */
async function compareExports(wasmModule, fixture) {
  const engine = new wasmModule.EngineWasm(512);
  for (const asset of fixture.assets) {
    engine.add_asset(asset.hash, new Uint8Array(readFileSync(join(ROOT, asset.path))), asset.mime);
  }
  engine.load_project(readFileSync(join(ROOT, fixture.project), "utf8"));
  const results = [];
  for (const { name, job } of EXPORT_JOBS) {
    const dir = join(work, `${fixture.name}.${name}`);
    const args = [
      "run",
      "--quiet",
      "-p",
      "bragi-engine-native",
      "--bin",
      "bragi-render",
      "--",
      "--project",
      join(ROOT, fixture.project),
      "--frames",
      String(fixture.frames),
      "--out",
      join(work, `${fixture.name}.${name}.wav`),
      "--export-job",
      JSON.stringify(job),
      "--export-dir",
      dir,
    ];
    for (const asset of fixture.assets)
      args.push("--asset", `${asset.hash}=${join(ROOT, asset.path)}`);
    run("cargo", args);
    const wasmFiles = readExportFrame(engine.export_frame(JSON.stringify(job)));
    for (const file of wasmFiles) {
      const nativeBytes = readFileSync(join(dir, file.name));
      const identical = Buffer.compare(nativeBytes, file.bytes) === 0;
      let level = Number.NEGATIVE_INFINITY;
      if (file.name.endsWith(".wav")) {
        level = nullLevelDb(decodeWav(nativeBytes), decodeWav(file.bytes));
      }
      results.push({
        fixture: fixture.name,
        job: name,
        file: file.name,
        identical,
        level,
        wav: file.name.endsWith(".wav"),
      });
    }
  }
  return results;
}

if (BUILD) {
  process.stdout.write("building the native render binary…\n");
  run("cargo", ["build", "-p", "bragi-engine-native", "--bin", "bragi-render"]);
  process.stdout.write("building the wasm engine…\n");
  run("node", ["scripts/build-engine-wasm.mjs"]);
}

mkdirSync(GOLDEN_DIR, { recursive: true });
const module = await loadWasm();
let failed = false;
const rows = [];

for (const fixture of FIXTURES) {
  const nativeWav = join(work, `${fixture.name}.native.wav`);
  const nativeRaw = join(work, `${fixture.name}.native.f32`);
  const native = renderNative(fixture, nativeWav, nativeRaw);
  const wasm = await renderWasm(module, fixture);
  const goldenPath = join(GOLDEN_DIR, `${fixture.name}.wav`);

  if (UPDATE) {
    copyFileSync(nativeWav, goldenPath);
  }

  const nativeVsWasm = nullLevelDb(native.samples, wasm);
  const hasGolden = existsSync(goldenPath);
  let nativeVsGolden = Number.NEGATIVE_INFINITY;
  let wasmVsGolden = Number.NEGATIVE_INFINITY;
  if (hasGolden) {
    const golden = readF32Wav(goldenPath).samples;
    nativeVsGolden = nullLevelDb(native.samples, golden);
    wasmVsGolden = nullLevelDb(wasm, golden);
  }
  if (!hasGolden && !UPDATE) {
    process.stderr.write(`${fixture.name}: missing golden; run with --update\n`);
  }

  const ok =
    hasGolden &&
    (!fixture.gate ||
      (nativeVsWasm <= NULL_TARGET_DB &&
        nativeVsGolden <= NULL_TARGET_DB &&
        wasmVsGolden <= NULL_TARGET_DB));
  failed ||= !ok;
  rows.push({
    fixture: fixture.name,
    frames: native.samples.length / 2,
    sha: native.sha.slice(0, 12),
    nativeVsWasm,
    nativeVsGolden,
    wasmVsGolden,
    ok,
    gate: fixture.gate,
  });
}

const exportRows = [];
// Exports render the main plan only, so a switch fixture adds nothing there.
for (const fixture of FIXTURES.filter((entry) => entry.gate && !entry.switches)) {
  exportRows.push(...(await compareExports(module, fixture)));
}
process.stdout.write("\nexport parity (native vs WASM)\n");
for (const row of exportRows) {
  const ok = row.wav ? row.level <= NULL_TARGET_DB : true;
  failed ||= !ok;
  process.stdout.write(
    `${row.fixture.padEnd(22)} ${row.job.padEnd(15)} ${row.file.padEnd(18)} ` +
      `${row.identical ? "bytes identical" : "bytes differ    "}  ` +
      `${row.wav ? `null ${row.level === Number.NEGATIVE_INFINITY ? "-inf" : row.level.toFixed(1)} dBFS` : "(flac: byte comparison only)"}` +
      `${ok ? "" : "  FAIL"}\n`,
  );
}

/** @param {number} value */
const formatDb = (value) =>
  value === Number.NEGATIVE_INFINITY ? "  -inf" : value.toFixed(1).padStart(6);
process.stdout.write(
  "\nfixture                    frames   sha256[0:12]  native/WASM  native/golden  WASM/golden  ok\n",
);
for (const row of rows) {
  process.stdout.write(
    `${row.fixture.padEnd(26)} ${String(row.frames).padStart(6)}   ${row.sha}   ` +
      `${formatDb(row.nativeVsWasm)}      ${formatDb(row.nativeVsGolden)}      ` +
      `${formatDb(row.wasmVsGolden)}   ${row.gate ? (row.ok ? "yes" : "NO") : "info"}\n`,
  );
}
process.stdout.write(
  `\nthreshold: ≤ ${NULL_TARGET_DB} dBFS for every gated pair ` +
    `(the stretch fixture is informational; see Q31 in specs/15-open-questions.md)\n`,
);

if (failed) {
  process.stderr.write("conformance failed\n");
  process.exitCode = 1;
} else {
  process.stdout.write("conformance passed\n");
}
