import type { PlanVariant } from "@bragi/schemas";
import { describe, expect, it } from "vitest";
import { diffDocuments, validateRawPlan } from "../validate.js";
import { loadModelWasm } from "../wasm.js";
import {
  draftPlan,
  FIRST_SECTION_DRUMS,
  opsVariant,
  testProject,
  testRequest,
  trackFx,
} from "./fixtures.js";

const model = await loadModelWasm();

/** The validation options for a request. */
function options(overrides: Partial<Parameters<typeof validateRawPlan>[1]> = {}) {
  return {
    request: testRequest(),
    model,
    songWideIntent: false,
    blockedNames: [],
    ...overrides,
  };
}

/** A clip op on the bass lane in the chorus. */
const bassChorus: PlanVariant["steps"] = [
  {
    kind: "ops",
    ops: [
      {
        op: "fx.add",
        scope: { kind: "clip", clipId: "clp_c2" },
        fx: { id: "fx_09", type: "filter", params: { cutoffHz: 800 }, bypass: false },
      },
    ],
  },
];

describe("validateRawPlan — region discipline", () => {
  it("accepts an op on a track inside the region", async () => {
    const result = await validateRawPlan(
      draftPlan([opsVariant("Warm", [trackFx("trk_drums")])]),
      options(),
    );
    expect(result.ok).toBe(true);
    expect(result.variants).toHaveLength(1);
  });

  it("drops a variant that touches a track outside the region", async () => {
    const result = await validateRawPlan(
      draftPlan([
        opsVariant("Warm drums", [trackFx("trk_drums", "fx_01")]),
        opsVariant("Bass", [trackFx("trk_bass", "fx_02")]),
      ]),
      options(),
    );
    expect(result.ok).toBe(true);
    expect(result.variants.map((variant) => variant.label)).toEqual(["Warm drums"]);
    expect(result.dropped.map((variant) => variant.label)).toEqual(["Bass"]);
    expect(result.dropped[0]?.reason).toMatch(/outside the selected region/);
  });

  it("rejects an op whose section span lies outside the region", async () => {
    const result = await validateRawPlan(
      draftPlan([{ label: "Chorus", description: "Filter", steps: bassChorus }]),
      options(),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/outside the selected region|outside the selected/);
  });

  it("accepts scope song only when the prompt had song-wide intent", async () => {
    const variant = opsVariant("Whole song", [trackFx("trk_bass")], "song");
    const notAsked = await validateRawPlan(draftPlan([variant]), options());
    expect(notAsked.ok).toBe(false);
    expect(notAsked.errors.join(" ")).toMatch(/did not ask for a whole-song change/);

    const asked = await validateRawPlan(
      draftPlan([variant]),
      options({
        request: testRequest({ prompt: "make the whole song bigger" }),
        songWideIntent: true,
      }),
    );
    expect(asked.ok).toBe(true);
  });

  it("rejects a structural change without song scope", async () => {
    const result = await validateRawPlan(
      draftPlan([
        {
          label: "Shorter",
          description: "Remove the chorus",
          steps: [
            { kind: "ops", ops: [{ op: "section.remove", sectionId: "sec_c", closeGap: true }] },
          ],
        },
      ]),
      options({
        request: testRequest({ region: { startTick: 0, endTick: 11520, tracks: "all" } }),
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/song structure/);
  });
});

describe("validateRawPlan — locks and v1 scope", () => {
  it("never changes a locked section", async () => {
    const result = await validateRawPlan(
      draftPlan([
        {
          label: "Mute chorus",
          description: "Trim the clip",
          steps: [
            {
              kind: "ops",
              ops: [
                {
                  op: "clip.update",
                  clipId: "clp_c1",
                  patch: { gainDb: -6 },
                },
              ],
            },
          ],
        },
      ]),
      options({
        request: testRequest({
          doc: testProject({ locked: false }),
          region: { startTick: 7680, endTick: 11520, tracks: "all" },
        }),
      }),
    );
    // sec_c is not locked in this fixture, so the same op passes; then the locked variant fails.
    expect(result.ok).toBe(true);

    const locked = await validateRawPlan(
      draftPlan([
        {
          label: "Change verse",
          description: "Trim the clip",
          steps: [
            { kind: "ops", ops: [{ op: "clip.update", clipId: "clp_b1", patch: { gainDb: -6 } }] },
          ],
        },
      ]),
      options({
        request: testRequest({
          doc: testProject({ locked: true }),
          region: { startTick: 0, endTick: 11520, tracks: "all" },
        }),
      }),
    );
    expect(locked.ok).toBe(false);
    expect(locked.errors.join(" ")).toMatch(/locked section/);
  });

  it("rejects a generate step because no capability is offered in v1", async () => {
    const result = await validateRawPlan(
      draftPlan([
        {
          label: "Generated",
          description: "New drums",
          steps: [
            {
              kind: "generate",
              id: "g1",
              capability: "generate.stem",
              params: { prompt: "dusty half-time drums" },
              context: { tracks: "all" },
            },
          ],
        },
      ]),
      options(),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/not available in v1/);
  });

  it("rejects an artist name left in a generation prompt with a policy violation", async () => {
    const result = await validateRawPlan(
      draftPlan([
        {
          label: "Generated",
          description: "New drums",
          steps: [
            {
              kind: "generate",
              id: "g1",
              capability: "generate.stem",
              params: { prompt: "a groove like Daft Punk" },
              context: { tracks: "all" },
            },
          ],
        },
      ]),
      options({ blockedNames: ["Daft Punk"] }),
    );
    expect(result.ok).toBe(false);
    expect(result.policyViolation).toMatch(/Daft Punk/);
  });

  it("rejects a schema-invalid draft", async () => {
    const result = await validateRawPlan({ interpretation: "", variants: "nope" }, options());
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects a plan with no variants and no clarification", async () => {
    const result = await validateRawPlan(draftPlan([]), options());
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/no variants/);
  });

  it("accepts a clarification with no variants", async () => {
    const result = await validateRawPlan(
      {
        interpretation: "Which way?",
        clarification: { question: "More or less?", options: ["More", "Less"] },
        variants: [],
      },
      options(),
    );
    expect(result.ok).toBe(true);
  });
});

describe("diffDocuments", () => {
  it("distinguishes track-level, lane-level and structural changes", () => {
    const before = testProject();
    const afterTrack = structuredClone(before);
    const changedTrack = afterTrack.tracks[0];
    if (changedTrack === undefined) throw new Error("fixture has no drum track");
    changedTrack.gainDb = -2;
    const trackDiff = diffDocuments(before, afterTrack);
    expect(trackDiff.songWide).toBe(false);
    expect(trackDiff.tracks.has("trk_drums")).toBe(true);
    expect(trackDiff.spans).toEqual([]);

    const afterLane = structuredClone(before);
    const changedLane = afterLane.arrangement.sections[0]?.lanes.trk_drums;
    const changedClip = changedLane?.clips[0];
    if (changedClip === undefined) throw new Error("fixture has no drum clip");
    changedClip.gainDb = -2;
    const laneDiff = diffDocuments(before, afterLane);
    expect(laneDiff.spans).toEqual([
      { startTick: FIRST_SECTION_DRUMS.startTick, endTick: FIRST_SECTION_DRUMS.endTick },
    ]);
    expect(laneDiff.tracks.has("trk_drums")).toBe(true);

    const afterStructure = structuredClone(before);
    afterStructure.arrangement.sections.pop();
    expect(diffDocuments(before, afterStructure).songWide).toBe(true);
  });
});
