import { describe, expect, it } from "vitest";

import {
  emptyStageResults,
  resolveStageInputs,
  resultBlob,
  type StageResults,
  withOutputs,
} from "../jobs/stage-inputs.js";

const UPLOAD = "sha256:aa";
const WORKING = "sha256:bb";
const VOCALS = "sha256:cc";
const DRUMS = "sha256:dd";
const RESIDUAL = "sha256:ee";
const RHYTHM = "sha256:01";
const STRUCTURE = "sha256:02";
const EMBED = "sha256:03";
const ACTIVITY = "sha256:04";
const SEPARATION = "sha256:05";

function results(
  stages: Record<string, { assets?: Record<string, string>; blobs?: Record<string, string> }>,
): StageResults {
  let current = emptyStageResults();
  for (const [stage, outputs] of Object.entries(stages)) {
    current = withOutputs(current, stage, outputs);
  }
  return current;
}

const afterIngest = results({
  ingest: { assets: { workingAsset: WORKING }, blobs: { result: "sha256:0f" } },
});

const afterSeparation = results({
  ingest: { assets: { workingAsset: WORKING }, blobs: { result: "sha256:0f" } },
  separation: {
    assets: { residual: RESIDUAL, stem_vocals: VOCALS, stem_drums: DRUMS },
    blobs: { separation: SEPARATION },
  },
});

describe("resolveStageInputs", () => {
  it("runs ingest on the upload itself", () => {
    expect(resolveStageInputs(UPLOAD, "ingest", afterSeparation)).toEqual({
      assets: { source: UPLOAD },
      blobs: {},
    });
  });

  it("passes the working asset downstream as both source and mix", () => {
    expect(resolveStageInputs(UPLOAD, "rhythm", afterIngest)).toEqual({
      assets: { source: WORKING, mix: WORKING },
      blobs: {},
    });
    expect(resolveStageInputs(UPLOAD, "separation", afterIngest)).toEqual({
      assets: { source: WORKING, mix: WORKING },
      blobs: {},
    });
  });

  it("falls back to the upload before ingest has finished", () => {
    expect(resolveStageInputs(UPLOAD, "rhythm", emptyStageResults())).toEqual({
      assets: { source: UPLOAD, mix: UPLOAD },
      blobs: {},
    });
  });

  it("attaches the stems and residual once separation is done", () => {
    const { assets } = resolveStageInputs(UPLOAD, "harmony", afterSeparation);
    expect(assets).toEqual({
      source: WORKING,
      mix: WORKING,
      residual: RESIDUAL,
      stem_vocals: VOCALS,
      stem_drums: DRUMS,
    });
  });

  it("attaches the optional upstream blob of each stage (04 §5–§6)", () => {
    const done = results({
      ingest: { assets: { workingAsset: WORKING } },
      separation: { assets: { stem_vocals: VOCALS }, blobs: { separation: SEPARATION } },
      rhythm: { blobs: { result: RHYTHM } },
      structure: { blobs: { result: STRUCTURE } },
      embed_full: { blobs: { embed_full: EMBED } },
      stem_activity: { blobs: { stem_activity: ACTIVITY } },
    });
    expect(resolveStageInputs(UPLOAD, "structure", done).blobs).toEqual({ rhythm: RHYTHM });
    expect(resolveStageInputs(UPLOAD, "harmony", done).blobs).toEqual({
      rhythm: RHYTHM,
      structure: STRUCTURE,
    });
    expect(resolveStageInputs(UPLOAD, "stem_activity", done).blobs).toEqual({
      structure: STRUCTURE,
    });
    expect(resolveStageInputs(UPLOAD, "section_embed", done).blobs).toEqual({
      structure: STRUCTURE,
    });
    expect(resolveStageInputs(UPLOAD, "tag", done).blobs).toEqual({ embed_full: EMBED });
    expect(resolveStageInputs(UPLOAD, "stem_embed", done).blobs).toEqual({
      stem_activity: ACTIVITY,
    });
  });

  it("hands describe every analysis blob that has finished", () => {
    const done = results({
      ingest: { assets: { workingAsset: WORKING }, blobs: { result: "sha256:0f" } },
      structure: { blobs: { result: STRUCTURE } },
      tag: { blobs: { tag: EMBED } },
      stem_activity: { blobs: { stem_activity: ACTIVITY } },
    });
    expect(resolveStageInputs(UPLOAD, "describe", done).blobs).toEqual({
      structure: STRUCTURE,
      tag: EMBED,
      stem_activity: ACTIVITY,
    });
  });

  it("omits a blob whose producer has not finished", () => {
    expect(resolveStageInputs(UPLOAD, "tag", afterIngest).blobs).toEqual({});
  });
});

describe("resultBlob", () => {
  it("prefers the stage's named blob over the first asset", () => {
    expect(
      resultBlob("ingest", { assets: { workingAsset: WORKING }, blobs: { result: RHYTHM } }),
    ).toBe(RHYTHM);
    expect(
      resultBlob("separation", {
        assets: { residual: RESIDUAL },
        blobs: { separation: SEPARATION },
      }),
    ).toBe(SEPARATION);
  });

  it("falls back to the first blob, then the first asset", () => {
    expect(resultBlob("unknown", { blobs: { anything: EMBED } })).toBe(EMBED);
    expect(resultBlob("unknown", { assets: { workingAsset: WORKING } })).toBe(WORKING);
    expect(resultBlob("unknown", undefined)).toBeUndefined();
  });
});

describe("withOutputs", () => {
  it("keeps results immutable and ignores empty asset maps", () => {
    const before = emptyStageResults();
    const after = withOutputs(before, "rhythm", { blobs: { result: RHYTHM } });
    expect(before.blobs.size).toBe(0);
    expect(after.blobs.get("rhythm")).toBe(RHYTHM);

    const empty = withOutputs(before, "separation", { assets: {} });
    expect(empty.assets.has("separation")).toBe(false);
  });
});
