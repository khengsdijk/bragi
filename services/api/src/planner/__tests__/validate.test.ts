import type { PlanRequest, PlanVariant, Region } from "@bragi/schemas";
import { describe, expect, it } from "vitest";
import { hasSongWideIntent } from "../classify.js";
import { analysedKey } from "../generation.js";
import { normalizePlanEnvelope } from "../json.js";
import { diffDocuments, validateRawPlan } from "../validate.js";
import { loadModelWasm } from "../wasm.js";
import {
  draftPlan,
  FIRST_SECTION_DRUMS,
  generationVariant,
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

  it("requires song scope for a structural change even without a region", async () => {
    const structural = (scope: "song" | undefined): PlanVariant => ({
      label: "Remove",
      description: "Remove the chorus",
      steps: [{ kind: "ops", ops: [{ op: "section.remove", sectionId: "sec_c", closeGap: true }] }],
      ...(scope === undefined ? {} : { scope }),
    });
    const request = testRequest({ prompt: "remove the chorus" });
    const unscoped = await validateRawPlan(draftPlan([structural(undefined)]), {
      ...options(),
      request,
      songWideIntent: true,
    });
    expect(unscoped.ok).toBe(false);
    expect(unscoped.errors.join(" ")).toMatch(/song-wide/);

    const scoped = await validateRawPlan(draftPlan([structural("song")]), {
      ...options(),
      request,
      songWideIntent: true,
    });
    expect(scoped.ok).toBe(true);
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

  it("rejects a capability the planner does not offer", async () => {
    const result = await validateRawPlan(
      draftPlan([
        generationVariant("Generated", {
          capability: "generate.stem",
          params: { prompt: "dusty half-time drums" },
        }),
      ]),
      options(),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/generate\.stem" is not offered/);
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

describe("validateRawPlan — precise op errors", () => {
  it("names the wrong property and the shape fx.add needs", async () => {
    const result = await validateRawPlan(
      {
        interpretation: "Warm the vocals.",
        variants: [
          {
            label: "Warm",
            description: "A little warmer.",
            steps: [
              {
                kind: "ops",
                ops: [
                  {
                    op: "fx.add",
                    trackId: "trk_vox",
                    fx: { id: "fx_01", type: "eq3", params: { lowDb: 2 }, bypass: false },
                  },
                ],
              },
            ],
          },
        ],
      },
      options(),
    );
    expect(result.ok).toBe(false);
    const text = result.errors.join("\n");
    expect(text).toMatch(/variant 1, op 1 \(fx\.add\): unknown property "trackId"/);
    expect(text).toMatch(/fx\.add needs "scope"/);
    // The noisy union branches must not come back.
    expect(text).not.toMatch(/sourceId|"stage"|"blob"|one of the allowed values/);
  });

  it("names a missing required property at the op and nested level", async () => {
    const missingScope = await validateRawPlan(
      {
        interpretation: "x",
        variants: [
          {
            label: "Warm",
            description: "d",
            steps: [
              {
                kind: "ops",
                ops: [
                  {
                    op: "fx.add",
                    fx: { id: "fx_01", type: "eq3", params: {}, bypass: false },
                  },
                ],
              },
            ],
          },
        ],
      },
      options(),
    );
    expect(missingScope.errors.join("\n")).toMatch(/missing "scope"/);

    const missingTrack = await validateRawPlan(
      {
        interpretation: "x",
        variants: [
          {
            label: "Warm",
            description: "d",
            steps: [
              {
                kind: "ops",
                ops: [
                  {
                    op: "fx.add",
                    scope: { kind: "track" },
                    fx: { id: "fx_01", type: "eq3", params: {}, bypass: false },
                  },
                ],
              },
            ],
          },
        ],
      },
      options(),
    );
    expect(missingTrack.errors.join("\n")).toMatch(/missing "scope\.trackId"/);
  });

  it("reports an unknown op or one the planner may not use with the usable list", async () => {
    const unknown = await validateRawPlan(
      {
        interpretation: "x",
        variants: [
          { label: "a", description: "d", steps: [{ kind: "ops", ops: [{ op: "fx.paint" }] }] },
        ],
      },
      options(),
    );
    expect(unknown.errors.join("\n")).toMatch(/unknown op "fx\.paint"; known ops are/);
    expect(unknown.errors.join("\n")).toContain("fx.add");

    const system = await validateRawPlan(
      {
        interpretation: "x",
        variants: [
          {
            label: "a",
            description: "d",
            steps: [{ kind: "ops", ops: [{ op: "analysis.apply" }] }],
          },
        ],
      },
      options(),
    );
    expect(system.errors.join("\n")).toMatch(/"analysis\.apply" is not an op the planner may use/);
  });

  it("accepts variants delivered as a JSON string after the envelope is unwrapped", async () => {
    const raw = normalizePlanEnvelope({
      interpretation: "A small change.",
      variants: JSON.stringify([
        {
          label: "Warm",
          description: "A little warmer.",
          steps: [{ kind: "ops", ops: [trackFx("trk_drums")] }],
        },
      ]),
    });
    const result = await validateRawPlan(raw, options());
    expect(result.ok).toBe(true);
    expect(result.variants.map((variant) => variant.label)).toEqual(["Warm"]);
  });
});

describe("validateRawPlan — generation steps", () => {
  /** The lasso around the fixture's second bar; the default variant fills it. */
  const GAP: Region = { startTick: 3840, endTick: 7680, tracks: "all" };

  /** Options whose request selects a region; `undefined` means the song view. */
  function withRegion(region: Region | undefined, prompt = "fill the gap in bar 2") {
    const request = songView(prompt);
    if (region !== undefined) request.region = region;
    return options({ request, songWideIntent: hasSongWideIntent(prompt) });
  }

  /** A request from the song view, with no lasso. */
  function songView(prompt: string): PlanRequest {
    const request = testRequest({ prompt });
    delete request.region;
    return request;
  }

  it("accepts an inpaint and fills its context from the song and the lasso", async () => {
    const result = await validateRawPlan(draftPlan([generationVariant("Fill")]), withRegion(GAP));
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    const variant = result.variants[0];
    if (variant === undefined) throw new Error("expected a variant");
    const generate = variant.steps[0];
    if (generate?.kind !== "generate") throw new Error("expected a generate step");
    // The lasso is the gap; four bars of context on each side clamp to the song.
    expect(generate.context.before).toEqual({ startTick: 0, endTick: 3840 });
    expect(generate.context.after).toEqual({ startTick: 7680, endTick: 11520 });
    // The server fills what the song knows and keeps the model's key.
    expect(generate.params.context).toEqual({
      bpm: 120,
      timeSignature: [4, 4],
      key: { tonic: "A", mode: "minor" },
      sectionKind: "verse",
      descriptors: [],
      seed: expect.any(Number),
    });
    // The gap is one bar, so `gapBars` is one no matter what the model wrote.
    expect(generate.params.gapBars).toBe(1);
    expect(generate.params.overlapBars).toBe(2);
  });

  it("keeps a seed the model wrote instead of deriving one", async () => {
    const result = await validateRawPlan(
      draftPlan([
        generationVariant("Fill", {
          params: {
            context: { key: { tonic: "A", mode: "minor" }, seed: 77 },
            tier: "preview",
            n: 1,
          },
        }),
      ]),
      withRegion(GAP),
    );
    const generate = result.variants[0]?.steps[0];
    if (generate?.kind !== "generate") throw new Error("expected a generate step");
    expect(generate.params.context).toMatchObject({ seed: 77 });
  });

  it("rejects a context without a key when the song has no analysis", async () => {
    const result = await validateRawPlan(
      draftPlan([generationVariant("Fill", { params: { context: {}, tier: "preview", n: 1 } })]),
      withRegion(GAP),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/params\.context\.key is required/);
  });

  it("fills the key from the analysis summary", async () => {
    const request = testRequest({
      doc: testProject({ analysedKey: "F# minor" }),
      prompt: "fill the gap in bar 2",
      region: GAP,
    });
    const result = await validateRawPlan(
      draftPlan([generationVariant("Fill", { params: { context: {}, tier: "preview", n: 1 } })]),
      options({ request, songWideIntent: false }),
    );
    expect(result.errors).toEqual([]);
    const generate = result.variants[0]?.steps[0];
    if (generate?.kind !== "generate") throw new Error("expected a generate step");
    expect(generate.params.context).toMatchObject({ key: { tonic: "F#", mode: "minor" } });
  });

  it("rejects a two-sided capability without a lasso and without ranges", async () => {
    const result = await validateRawPlan(
      draftPlan([generationVariant("Fill")]),
      withRegion(undefined),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/needs the lasso around the gap/);
  });

  it("rejects a gap inside a locked section", async () => {
    const request = testRequest({
      doc: testProject({ locked: true }),
      prompt: "fill the gap in bar 2",
      region: GAP,
    });
    const result = await validateRawPlan(
      draftPlan([generationVariant("Fill")]),
      options({ request, songWideIntent: false }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/locked section/);
  });

  it("rejects a gap that is not whole bars", async () => {
    const result = await validateRawPlan(
      draftPlan([generationVariant("Fill")]),
      withRegion({ startTick: 3840, endTick: 5800, tracks: "all" }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/whole bar/);
  });

  it("rejects context ranges outside the song", async () => {
    const result = await validateRawPlan(
      draftPlan([
        generationVariant("Fill", {
          context: {
            before: { startTick: 0, endTick: 3840 },
            after: { startTick: 7680, endTick: 999_999 },
            tracks: "all",
          },
        }),
      ]),
      withRegion(GAP),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/outside the song/);
  });

  it("rejects an unknown track in the context", async () => {
    const result = await validateRawPlan(
      draftPlan([generationVariant("Fill", { context: { tracks: ["trk_nope"] } })]),
      withRegion(GAP),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/unknown track trk_nope/);
  });

  it("derives a transition's boundary and context from the lasso", async () => {
    const result = await validateRawPlan(
      draftPlan([
        generationVariant("Bridge", {
          capability: "generate.transition",
          params: {
            context: { key: { tonic: "A", mode: "minor" } },
            lengthBars: 2,
            tier: "preview",
            n: 2,
          },
          placement: {
            region: { startTick: 3840, endTick: 7680, tracks: "all" },
            mode: "replace",
            newTrack: { name: "Bridge", role: "other" },
          },
        }),
      ]),
      withRegion({ startTick: 1920, endTick: 5760, tracks: "all" }, "smooth the transition"),
    );
    expect(result.errors).toEqual([]);
    const generate = result.variants[0]?.steps[0];
    if (generate?.kind !== "generate") throw new Error("expected a generate step");
    // The nearest section boundary to the lasso's middle is sec_b at 3840.
    expect(generate.context.before).toEqual({ startTick: 0, endTick: 3840 });
    expect(generate.context.after).toEqual({ startTick: 3840, endTick: 11520 });
  });

  it("rejects a transition whose two sides do not meet", async () => {
    const result = await validateRawPlan(
      draftPlan([
        generationVariant("Bridge", {
          capability: "generate.transition",
          params: {
            context: { key: { tonic: "A", mode: "minor" } },
            lengthBars: 1,
            tier: "preview",
            n: 1,
          },
          context: {
            before: { startTick: 0, endTick: 3000 },
            after: { startTick: 3840, endTick: 7680 },
            tracks: "all",
          },
          placement: {
            region: { startTick: 3000, endTick: 3840, tracks: "all" },
            mode: "replace",
            newTrack: { name: "Bridge", role: "other" },
          },
        }),
      ]),
      withRegion({ startTick: 1920, endTick: 5760, tracks: "all" }, "smooth the transition"),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/must start where context\.before ends/);
  });

  it("rejects a transition into a locked section", async () => {
    const request = testRequest({
      doc: testProject({ locked: true }),
      prompt: "smooth the transition",
      region: { startTick: 1920, endTick: 5760, tracks: "all" },
    });
    const result = await validateRawPlan(
      draftPlan([
        generationVariant("Bridge", {
          capability: "generate.transition",
          params: {
            context: { key: { tonic: "A", mode: "minor" } },
            lengthBars: 1,
            tier: "preview",
            n: 1,
          },
          context: {
            before: { startTick: 0, endTick: 3840 },
            after: { startTick: 3840, endTick: 7680 },
            tracks: "all",
          },
          placement: {
            region: { startTick: 3840, endTick: 7680, tracks: "all" },
            mode: "replace",
            newTrack: { name: "Bridge", role: "other" },
          },
        }),
      ]),
      options({ request, songWideIntent: false }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/locked section/);
  });

  it("requires song scope for an extend and places it at the song edge", async () => {
    const extend = (scope: "song" | undefined) =>
      generationVariant("Longer", {
        capability: "generate.extend",
        params: {
          context: { key: { tonic: "A", mode: "minor" } },
          bars: 4,
          direction: "forward",
          tier: "preview",
          n: 1,
        },
        placement: {
          region: { startTick: 11520, endTick: 26880, tracks: "all" },
          mode: "replace",
          newTrack: { name: "Generated", role: "other" },
        },
        ...(scope === undefined ? {} : { scope }),
      });
    const prompt = "extend the outro by 4 bars";
    const request = songView(prompt);
    const unscoped = await validateRawPlan(draftPlan([extend(undefined)]), {
      ...options({ request, songWideIntent: true }),
    });
    expect(unscoped.ok).toBe(false);
    expect(unscoped.errors.join(" ")).toMatch(/needs scope "song"/);

    const scoped = await validateRawPlan(draftPlan([extend("song")]), {
      ...options({ request, songWideIntent: true }),
    });
    expect(scoped.errors).toEqual([]);
    expect(scoped.ok).toBe(true);
  });

  it("rejects an extend with no room at the song end", async () => {
    const result = await validateRawPlan(
      draftPlan([
        generationVariant("Longer", {
          capability: "generate.extend",
          params: {
            context: { key: { tonic: "A", mode: "minor" } },
            bars: 4,
            direction: "forward",
            tier: "preview",
            n: 1,
          },
          placement: {
            region: { startTick: 0, endTick: 3840, tracks: "all" },
            mode: "replace",
            newTrack: { name: "Generated", role: "other" },
          },
          scope: "song",
        }),
      ]),
      options({
        request: songView("extend the outro by 4 bars"),
        songWideIntent: true,
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/placed at the end of the song/);
  });

  it("rejects a placement that does not name an earlier generate step", async () => {
    const result = await validateRawPlan(
      draftPlan([
        generationVariant("Fill", {
          placement: {
            region: { startTick: 3840, endTick: 7680, tracks: ["trk_drums"] },
            trackId: "trk_drums",
            mode: "replace",
          },
        }),
      ]),
      withRegion(GAP),
    );
    expect(result.ok).toBe(true);
    const wrong = await validateRawPlan(
      {
        interpretation: "x",
        variants: [
          {
            label: "Fill",
            description: "x",
            steps: [
              {
                kind: "apply_generated",
                from: "g9",
                placement: {
                  region: { startTick: 3840, endTick: 7680, tracks: ["trk_drums"] },
                  trackId: "trk_drums",
                  mode: "replace",
                },
              },
              {
                kind: "generate",
                id: "g9",
                capability: "generate.inpaint",
                params: { context: { key: { tonic: "A", mode: "minor" } }, tier: "preview", n: 1 },
                context: { tracks: "all" },
              },
            ],
          },
        ],
      },
      withRegion(GAP),
    );
    expect(wrong.ok).toBe(false);
    expect(wrong.errors.join(" ")).toMatch(/not an earlier generate step/);
  });

  it("rejects a generate step that is never placed", async () => {
    const result = await validateRawPlan(
      {
        interpretation: "x",
        variants: [
          {
            label: "Fill",
            description: "x",
            steps: [
              {
                kind: "generate",
                id: "g1",
                capability: "generate.inpaint",
                params: { context: { key: { tonic: "A", mode: "minor" } }, tier: "preview", n: 1 },
                context: { tracks: "all" },
              },
            ],
          },
        ],
      },
      withRegion(GAP),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/is never placed/);
  });

  it("rejects a placement region that is not the gap", async () => {
    const result = await validateRawPlan(
      draftPlan([
        generationVariant("Fill", {
          placement: {
            region: { startTick: 0, endTick: 3840, tracks: ["trk_drums"] },
            trackId: "trk_drums",
            mode: "replace",
          },
        }),
      ]),
      withRegion(GAP),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/fills its gap/);
  });

  it("accepts smooth tools after a placement and rejects a locked region", async () => {
    const accepted = await validateRawPlan(
      draftPlan([
        generationVariant("Fill", {
          smooth: { startTick: 3840, endTick: 7680, tracks: ["trk_drums"] },
        }),
      ]),
      withRegion(GAP),
    );
    expect(accepted.errors).toEqual([]);
    expect(accepted.ok).toBe(true);

    const request = testRequest({
      doc: testProject({ locked: true }),
      prompt: "fill the gap in bar 2",
      region: GAP,
    });
    const locked = await validateRawPlan(
      draftPlan([
        generationVariant("Fill", {
          smooth: { startTick: 3840, endTick: 7680, tracks: ["trk_drums"] },
        }),
      ]),
      options({ request, songWideIntent: false }),
    );
    expect(locked.ok).toBe(false);
    expect(locked.errors.join(" ")).toMatch(/smooth region would change a locked section/);
  });

  it("allows at most one generative variant", async () => {
    const result = await validateRawPlan(
      draftPlan([generationVariant("Fill A"), generationVariant("Fill B", { id: "g2" })]),
      withRegion(GAP),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/at most one variant per plan/);
  });

  it("requires generate step ids to be unique across variants", async () => {
    const result = await validateRawPlan(
      draftPlan([generationVariant("Fill A"), generationVariant("Fill B")]),
      withRegion(GAP),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/used twice in the plan/);
  });

  it("estimates credits and seconds, and refuses a plan above the ceiling", async () => {
    const priced = await validateRawPlan(draftPlan([generationVariant("Fill")]), withRegion(GAP));
    // One bar of gap is one 30 s window: 2 credits per candidate, two candidates.
    expect(priced.estimate).toEqual({ estimatedCredits: 4, estimatedSeconds: 30 });

    const capped = await validateRawPlan(draftPlan([generationVariant("Fill")]), {
      ...withRegion(GAP),
      maxCredits: 2,
    });
    expect(capped.ok).toBe(false);
    expect(capped.errors.join(" ")).toMatch(/needs 4 credits, but only 2 are available/);
  });

  it("keeps an ops-only variant free", async () => {
    const result = await validateRawPlan(
      draftPlan([opsVariant("Warm", [trackFx("trk_drums")])]),
      options(),
    );
    expect(result.estimate).toEqual({ estimatedCredits: 0, estimatedSeconds: 0 });
  });
});

describe("analysedKey", () => {
  it("prefers the harmony key effect and keeps the summary as the fallback", () => {
    const withEffect = testProject();
    withEffect.analyses.src_a = {
      profile: "standard",
      status: { harmony: "done" },
      blobs: {},
      effects: [{ kind: "key", tonic: "f#", mode: "minor" }],
    };
    expect(analysedKey(withEffect)).toEqual({ tonic: "F#", mode: "minor" });

    expect(analysedKey(testProject({ analysedKey: "G major" }))).toEqual({
      tonic: "G",
      mode: "major",
    });

    // An effect wins over a summary, so a re-analysis after the fix is authoritative.
    const both = testProject({ analysedKey: "A major" });
    const existing = both.analyses.src_a;
    if (existing === undefined) throw new Error("the fixture has no analysis");
    both.analyses.src_a = {
      ...existing,
      effects: [{ kind: "key", tonic: "F#", mode: "minor" }],
    };
    expect(analysedKey(both)).toEqual({ tonic: "F#", mode: "minor" });
  });

  it("returns undefined for a song with no analysis", () => {
    expect(analysedKey(testProject())).toBeUndefined();
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
