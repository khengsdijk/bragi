/**
 * Tick-accurate region discipline (06 §7): a lasso smaller than its section can edit its ticks,
 * while a change that really reaches past them is still rejected.
 *
 * The song is one eight-bar section with a clip covering all of it, so a two-bar region is
 * genuinely inside a section unlike in the three-one-bar-section fixture.
 */
import type { Op, PlanRequest, PlanVariant, Project, Region } from "@bragi/schemas";
import { describe, expect, it } from "vitest";
import { validateRawPlan } from "../validate.js";
import { loadModelWasm } from "../wasm.js";
import { draftPlan, opsVariant } from "./fixtures.js";

const model = await loadModelWasm();

const BAR = 3_840;
const EIGHT_BARS = 8 * BAR;
/** The two bars this file edits, in the middle of the section. */
const MID = 3 * BAR;
const ASSET = `sha256:${"1".repeat(64)}`;
const DATE = "2026-10-18T12:00:00Z";

/** One eight-bar section, one drums track, one clip covering the section. */
function longProject(): Project {
  return {
    schemaVersion: 1,
    id: "prj_01JAB3QK7M9P2V6XWN0T4Y8ZB5",
    meta: { title: "Long section", createdAt: DATE, tags: [] },
    sources: [],
    analyses: {},
    tracks: [
      {
        id: "trk_drums",
        name: "Drums",
        role: "drums",
        color: "#8A8F98",
        gainDb: 0,
        pan: 0,
        mute: false,
        solo: false,
        hidden: false,
        fx: [],
      },
    ],
    arrangement: {
      timebase: {
        ppq: 960,
        tempoMap: [{ tick: 0, bpm: 120, curve: "step" }],
        timeSignatures: [{ bar: 0, numerator: 4, denominator: 4 }],
      },
      sections: [
        {
          id: "sec_a",
          kind: "verse",
          label: "Verse",
          lengthTicks: EIGHT_BARS,
          transitionIn: { kind: "cut", lengthTicks: 0 },
          lanes: {
            trk_drums: {
              clips: [
                {
                  id: "clp_long",
                  asset: ASSET,
                  srcStart: 0,
                  srcEnd: 48_000,
                  start: 0,
                  warp: {
                    mode: "beatgrid" as const,
                    anchors: [
                      { srcSample: 0, tick: 0 },
                      { srcSample: 48_000, tick: EIGHT_BARS },
                    ],
                  },
                  gainDb: 0,
                  pitchSemitones: 0,
                  fadeInTicks: 0,
                  fadeOutTicks: 0,
                  fadeCurve: "equal_power" as const,
                  provenance: { kind: "user" as const, createdAt: DATE },
                },
              ],
              automation: [],
            },
          },
        },
      ],
      master: { fx: [], automation: [], gainDb: 0 },
    },
  };
}

/** A request over the long section with the given lasso. */
function request(region: Region, doc: Project = longProject()): PlanRequest {
  return {
    doc,
    prompt: "replace these bars with a new drum fill",
    region,
    uiContext: { view: "moment", selectedTrackIds: ["trk_drums"], selectedSectionIds: ["sec_a"] },
  };
}

/** Validation options for that request. */
function options(region: Region, doc: Project = longProject()) {
  return {
    request: request(region, doc),
    model,
    songWideIntent: false,
    blockedNames: [],
  };
}

/** `longProject` with its clip ending exactly at the region start, so its fade-out touches it. */
function projectWithClipBeforeRegion(): Project {
  const project = longProject();
  const clip = project.arrangement.sections[0]?.lanes.trk_drums?.clips[0];
  if (clip === undefined) throw new Error("fixture has no drum clip");
  clip.warp = {
    mode: "beatgrid" as const,
    anchors: [
      { srcSample: 0, tick: 0 },
      { srcSample: 48_000, tick: MID },
    ],
  };
  return project;
}

/** A `region.clear` over absolute ticks. */
function clear(startTick: number, endTick: number): Op {
  return { op: "region.clear", region: { startTick, endTick, tracks: "all" } };
}

/** A one-step ops variant. */
function variant(ops: [Op, ...Op[]]): PlanVariant {
  return opsVariant("Fill", ops);
}

describe("tick-accurate region discipline", () => {
  it("accepts clearing two bars inside an eight-bar section when the lasso is those bars", async () => {
    const result = await validateRawPlan(
      draftPlan([variant([clear(MID, MID + 2 * BAR)])]),
      options({ startTick: MID, endTick: MID + 2 * BAR, tracks: "all" }),
    );
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("rejects the same clear when the lasso covers only the first of the two bars", async () => {
    const result = await validateRawPlan(
      draftPlan([variant([clear(MID, MID + 2 * BAR)])]),
      options({ startTick: MID, endTick: MID + BAR, tracks: "all" }),
    );
    expect(result.ok).toBe(false);
    const text = result.errors.join(" ");
    expect(text).toMatch(/It touches ticks/);
    expect(text).toMatch(/outside the selected region/);
  });

  it("accepts a lane automation curve fully inside a sub-section region", async () => {
    const automation: Op = {
      op: "automation.set",
      scope: { kind: "lane", sectionId: "sec_a", trackId: "trk_drums" },
      target: "track:trk_drums/gainDb",
      points: [
        { tick: MID + 480, value: 0.2, curve: "linear" },
        { tick: MID + BAR, value: 0.8, curve: "linear" },
      ],
    };
    const result = await validateRawPlan(
      draftPlan([variant([automation])]),
      options({ startTick: MID, endTick: MID + 2 * BAR, tracks: ["trk_drums"] }),
    );
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("accepts a neutral fx added to a clip whose automation stays inside the lasso", async () => {
    const neutral: Op = {
      op: "fx.add",
      scope: { kind: "clip", clipId: "clp_long" },
      fx: { id: "fx_neutral", type: "eq3", params: { lowDb: 0 }, bypass: false },
    };
    const automation: Op = {
      op: "automation.set",
      scope: { kind: "lane", sectionId: "sec_a", trackId: "trk_drums" },
      target: "fx:fx_neutral/lowDb",
      points: [
        { tick: MID + 480, value: 0, curve: "linear" },
        { tick: MID + BAR, value: 6, curve: "linear" },
      ],
    };
    const result = await validateRawPlan(
      draftPlan([variant([neutral, automation])]),
      options({ startTick: MID, endTick: MID + 2 * BAR, tracks: ["trk_drums"] }),
    );
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("rejects a clip gain change spanning the whole section with a sub-section lasso", async () => {
    const gain: Op = { op: "clip.update", clipId: "clp_long", patch: { gainDb: -3 } };
    const result = await validateRawPlan(
      draftPlan([variant([gain])]),
      options({ startTick: MID, endTick: MID + 2 * BAR, tracks: ["trk_drums"] }),
    );
    expect(result.ok).toBe(false);
    const text = result.errors.join(" ");
    expect(text).toMatch(/It touches ticks 0–30720/);
    expect(text).toMatch(/outside the selected region/);
  });

  it("rejects a two-bar fade-out on the clip before the region", async () => {
    const doc = projectWithClipBeforeRegion();
    const fade: Op = {
      op: "clip.update",
      clipId: "clp_long",
      patch: { fadeOutTicks: 2 * BAR },
    };
    const result = await validateRawPlan(
      draftPlan([variant([fade])]),
      options({ startTick: MID, endTick: MID + 2 * BAR, tracks: ["trk_drums"] }, doc),
    );
    expect(result.ok).toBe(false);
    const text = result.errors.join(" ");
    expect(text).toMatch(new RegExp(`It touches ticks ${MID - 2 * BAR}–${MID}`));
    expect(text).toMatch(/outside the selected region/);
  });
});
