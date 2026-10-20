// The handle-based WASM API, exercised from Node against the built `packages/model-wasm`
// (specs/12-roadmap.md WP-0.3: "packages/model-wasm built and its handle API tested").
//
// This is the only place the wasm-bindgen output is called: the Rust unit tests cover the model
// logic, and this file proves the boundary (JSON in, handles out, the hot paths reused) works and
// that a 50-op batch on a 20-minute document stays under the 5 ms budget. (The fixture is
// deliberately ~20 minutes — 60 sections × 10 bars — which is stricter than the 10-minute
// criterion in specs/12-roadmap.md WP-0.3.)
//
// Prerequisite: `pnpm build:model-wasm` has run.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const JS = new URL("../../packages/model-wasm/generated/bragi_model_wasm.js", import.meta.url);
const WASM = new URL(
  "../../packages/model-wasm/generated/bragi_model_wasm_bg.wasm",
  import.meta.url,
);

const model = await import(JS.href);
model.initSync({ module: readFileSync(fileURLToPath(WASM)) });

/** A project with `tracks` tracks and `sections` 10-bar sections, JSON-serialised. */
function twentyMinuteProject(tracks = 12, sections = 60) {
  const hash = `sha256:${"1".repeat(64)}`;
  let clipCounter = 0;
  /**
   * @param {string} id
   * @param {number} start
   */
  const clip = (id, start) => ({
    id,
    asset: hash,
    srcStart: 0,
    srcEnd: 48000,
    start,
    warp: {
      mode: "beatgrid",
      anchors: [
        { srcSample: 0, tick: start },
        { srcSample: 48000, tick: start + 1920 },
      ],
    },
    gainDb: 0,
    pitchSemitones: 0,
    fadeInTicks: 0,
    fadeOutTicks: 0,
    fadeCurve: "equal_power",
    provenance: { kind: "user", createdAt: "2026-10-18T12:00:00Z" },
  });
  return JSON.stringify({
    schemaVersion: 1,
    id: "prj_01",
    meta: { title: "Bench", createdAt: "2026-10-18T12:00:00Z", tags: [] },
    sources: [],
    analyses: {},
    tracks: Array.from({ length: tracks }, (_, t) => ({
      id: `trk_${t}`,
      name: `Track ${t}`,
      role: t === 0 ? "full_mix" : "other",
      color: "#8A8F98",
      gainDb: 0,
      pan: 0,
      mute: false,
      solo: false,
      hidden: false,
      fx: [],
    })),
    arrangement: {
      timebase: {
        ppq: 960,
        tempoMap: [{ tick: 0, bpm: 120, curve: "step" }],
        timeSignatures: [{ bar: 0, numerator: 4, denominator: 4 }],
      },
      sections: Array.from({ length: sections }, (_, s) => {
        const length = 10 * 3840;
        /** @type {Record<string, unknown>} */
        const lanes = {};
        for (let t = 0; t < tracks; t += 1) {
          lanes[`trk_${t}`] = {
            clips: [clip(`clp_${clipCounter++}a`, 0), clip(`clp_${clipCounter++}b`, 1920)],
            automation: [],
          };
        }
        return {
          id: `sec_${s}`,
          kind: "verse",
          label: `S${s}`,
          lengthTicks: length,
          lanes,
          transitionIn: { kind: "cut", lengthTicks: 0 },
        };
      }),
      master: { fx: [], automation: [], gainDb: 0 },
    },
  });
}

const assetMeta = JSON.stringify([
  {
    hash: `sha256:${"1".repeat(64)}`,
    mime: "audio/flac",
    bytes: 1,
    sampleRate: 48000,
    channels: 2,
    durationSamples: 4800000,
  },
]);

/**
 * @param {unknown[]} ops
 * @returns {string}
 */
const batch = (ops) =>
  JSON.stringify({
    id: "bat_01",
    label: "Bench batch",
    createdAt: "2026-10-18T12:00:00Z",
    author: { kind: "user" },
    ops,
  });

describe("model-wasm handle API", () => {
  it("loads, validates, queries, applies and frees a document", () => {
    const handle = model.loadProject(twentyMinuteProject(2, 3));
    model.assetAdd(handle, assetMeta);
    expect(model.validateDoc(handle)).toBeUndefined();
    expect(model.docCount()).toBeGreaterThan(0);

    const spans = JSON.parse(model.sectionSpans(handle));
    expect(spans).toHaveLength(3);
    expect(spans[1].startTick).toBe(10 * 3840);

    expect(model.ticksToSeconds(handle, 1920n)).toBeCloseTo(1.0);
    expect(model.secondsToTicks(handle, 1.0)).toBe(1920n);

    const region = JSON.stringify({ startTick: 0, endTick: 4000, tracks: "all" });
    const resolved = JSON.parse(model.resolveRegion(handle, region));
    expect(resolved.slices.length).toBeGreaterThan(0);

    const applied = model.applyBatch(handle, batch([{ op: "project.set_meta", title: "Renamed" }]));
    expect(JSON.parse(applied).meta.title).toBe("Renamed");
    expect(model.canonicalJson(handle)).toContain('"title":"Renamed"');

    const other = model.loadProject(twentyMinuteProject(2, 3));
    const delta = JSON.parse(model.diffDocs(other, handle));
    expect(delta.metaChanged).toBe(true);

    const commitId = model.commitId(
      "[]",
      batch([{ op: "project.set_meta", title: "x" }]),
      `sha256:${"2".repeat(64)}`,
    );
    expect(commitId.startsWith("cmt_")).toBe(true);
    expect(commitId).toHaveLength(4 + 26);

    expect(model.freeDoc(handle)).toBe(true);
    expect(model.freeDoc(other)).toBe(true);
    expect(model.freeDoc(999999)).toBe(false);
    // A freed handle is gone: every call on it fails rather than touching stale state.
    expect(() => model.validateDoc(handle)).toThrow(/unknown handle/);
    expect(model.docCount()).toBe(0);
  });

  it("summarizes a document for the planner from Node", () => {
    const handle = model.loadProject(twentyMinuteProject(2, 3));
    model.assetAdd(handle, assetMeta);

    const whole = model.summarizeForLlm(handle, "");
    expect(whole).toContain('SONG: "Bench"');
    expect(whole).toContain('TRACKS: trk_0 "Track 0"(full_mix) | trk_1 "Track 1"(other)');
    expect(whole).toContain(
      "SECTIONS (idx, id, kind, bars, startBar, energy, chords, active stems, locked):",
    );
    expect(whole).toContain("FOCUS: whole song");
    expect(whole).toContain("CURRENT FX/MACROS: none");

    const focused = model.summarizeForLlm(
      handle,
      JSON.stringify({ selectedSectionIds: ["sec_1"], selectedTrackIds: ["trk_1"] }),
    );
    expect(focused).toContain('FOCUS: sections: sec_1 "S1" · tracks: trk_1 "Track 1"');

    const region = model.summarizeForLlm(
      handle,
      JSON.stringify({ region: { startTick: 0, endTick: 4000, tracks: ["trk_1"] } }),
    );
    expect(region).toContain('FOCUS REGION: bars 1–2 (sec_0 "S0") · tracks: trk_1 "Track 1"');

    expect(() => model.summarizeForLlm(handle, '{"selectedTrackIds":["trk_missing"]}')).toThrow(
      /unknown_track/,
    );
    expect(model.freeDoc(handle)).toBe(true);
  });

  it("returns structured errors for an invalid batch", () => {
    const handle = model.loadProject(twentyMinuteProject(1, 1));
    model.assetAdd(handle, assetMeta);
    expect(() =>
      model.applyBatch(
        handle,
        batch([{ op: "track.update", trackId: "trk_missing", patch: { gainDb: 1 } }]),
      ),
    ).toThrow(/missing_target/);
    model.freeDoc(handle);
  });

  it("applies a 50-op batch on a 20-minute document in under 5 ms", () => {
    const handle = model.loadProject(twentyMinuteProject());
    model.assetAdd(handle, assetMeta);
    expect(model.validateDoc(handle)).toBeUndefined();

    const ops = [];
    for (let t = 0; t < 12; t += 1) {
      ops.push({ op: "track.update", trackId: `trk_${t}`, patch: { gainDb: -(t % 7) } });
    }
    for (let s = 0; ops.length < 50; s += 1) {
      ops.push({ op: "section.update", sectionId: `sec_${s}`, patch: { label: `R${s}` } });
    }
    const batchJson = batch(ops);

    // Warm up, then take the best of several runs (the JIT and the wasm memory grow on the first).
    const times = [];
    for (let run = 0; run < 8; run += 1) {
      const start = performance.now();
      model.applyBatch(handle, batchJson);
      times.push(performance.now() - start);
    }
    const best = Math.min(...times);
    process.stdout.write(`[model-wasm] 50-op apply on a 20-minute doc: ${best.toFixed(3)} ms\n`);
    expect(best).toBeLessThan(5);
    model.freeDoc(handle);
  });
});
