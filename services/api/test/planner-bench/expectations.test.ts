import type { EditPlan, Op, PlanStep, PlanVariant, Project, Region } from "@bragi/schemas";
import { describe, expect, it } from "vitest";

import { type Expectations, evaluateExpectations, leverOf, overReaches } from "./expectations.js";
import { loadFixture } from "./run.js";

const PLAN_ID = "pln_01JAB5H7K8M9N0P1Q2R3S4T5V6";

/** The paper-lanterns verse, drums only. */
const VERSE_DRUMS: Region = {
  startTick: 15360,
  endTick: 46080,
  tracks: ["trk_drums"],
};

/** A track fx. */
function trackFx(trackId: string, fxId = "fx_warm"): Op {
  return {
    op: "fx.add",
    scope: { kind: "track", trackId },
    fx: { id: fxId, type: "saturation", params: { drive: 0.5 }, bypass: false },
  };
}

/** A clip fx on the verse's drum clip. */
function clipFx(clipId = "clp_110", fxId = "fx_clip"): Op {
  return {
    op: "fx.add",
    scope: { kind: "clip", clipId },
    fx: { id: fxId, type: "eq3", params: { lowDb: 2 }, bypass: false },
  };
}

/** Lane automation on a section. */
function laneAutomation(sectionId: string, trackId: string, target: string): Op {
  return {
    op: "automation.set",
    scope: { kind: "lane", sectionId, trackId },
    target,
    points: [
      { tick: 0, value: 0, curve: "linear" },
      { tick: 30720, value: 1, curve: "linear" },
    ],
  };
}

/** One non-empty ops step. */
function step(first: Op, ...rest: Op[]): PlanStep {
  return { kind: "ops", ops: [first, ...rest] };
}

/** A variant, optionally song-scoped. */
function variant(label: string, scopeOrStep: "song" | PlanStep, ...rest: PlanStep[]): PlanVariant {
  const song = scopeOrStep === "song";
  const steps = song ? rest : [scopeOrStep, ...rest];
  const [first, ...others] = steps;
  if (first === undefined) throw new Error("a variant needs at least one step");
  return {
    label,
    description: `${label} variant`,
    steps: [first, ...others],
    ...(song ? { scope: "song" as const } : {}),
  };
}

/** A valid plan. The tests use one variant; the schema also allows zero or more. */
function plan(variants: PlanVariant[], notices?: string[]): EditPlan {
  const first = variants[0];
  return {
    planId: PLAN_ID,
    interpretation: "I'll shape the drums for this part.",
    variants: first === undefined ? [] : [first],
    estimatedCredits: 0,
    estimatedSeconds: 0,
    ...(notices === undefined ? {} : { notices }),
  };
}

/** Evaluates against the paper-lanterns verse. */
function evaluate(
  planValue: EditPlan,
  expectations: Expectations,
  options: { doc?: Project; region?: Region; dropped?: string[] } = {},
) {
  return evaluateExpectations({
    plan: planValue,
    doc: options.doc ?? loadFixture("paper-lanterns"),
    expectations,
    region: options.region ?? VERSE_DRUMS,
    ...(options.dropped === undefined ? {} : { dropped: options.dropped }),
  });
}

/** The named checks that failed. */
function failed(result: ReturnType<typeof evaluate>): string[] {
  return result.checks.filter((check) => !check.ok).map((check) => check.name);
}

describe("evaluateExpectations — region discipline", () => {
  it("accepts a clip fx inside the region", () => {
    const result = evaluate(plan([variant("Warm", step(clipFx()))]), {
      onlyOpKinds: ["fx.add"],
      touchesOnlyTracks: ["trk_drums"],
      insideRegion: true,
      timeLimited: true,
    });
    expect(failed(result)).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it("flags a bare track-level fx as not time-limited", () => {
    const result = evaluate(plan([variant("Warm", step(trackFx("trk_drums")))]), {
      insideRegion: true,
      timeLimited: true,
    });
    expect(failed(result)).toEqual(["timeLimited"]);
    expect(result.checks.find((check) => check.name === "timeLimited")?.detail).toMatch(
      /bare track\/master fx/,
    );
  });

  it("accepts a clip fx update: a clip chain is already time-limited", () => {
    const doc = structuredClone(loadFixture("paper-lanterns"));
    const lane = doc.arrangement.sections[1]?.lanes.trk_drums;
    const clip = lane?.clips[0];
    if (lane === undefined || clip === undefined) throw new Error("fixture has no drum clip");
    lane.clips[0] = {
      ...clip,
      fx: [{ id: "fx_existing", type: "eq3", params: {}, bypass: false }],
    };
    const result = evaluate(
      plan([
        variant("Clip", step({ op: "fx.update", fxId: "fx_existing", paramsPatch: { lowDb: 2 } })),
      ]),
      { timeLimited: true, insideRegion: true },
      { doc },
    );
    expect(failed(result)).toEqual([]);
  });

  it("accepts a track fx driven by lane automation on the same fx", () => {
    const result = evaluate(
      plan([
        variant(
          "Warm and moved",
          step(
            trackFx("trk_drums", "fx_warm"),
            laneAutomation("sec_b", "trk_drums", "fx:fx_warm/drive"),
          ),
        ),
      ]),
      { insideRegion: true, timeLimited: true },
    );
    expect(failed(result)).toEqual([]);
  });

  it("flags a track outside the region and a tick span outside it", () => {
    const outside = evaluate(plan([variant("Bass", step(trackFx("trk_bass")))]), {
      touchesOnlyTracks: ["trk_drums"],
      insideRegion: true,
    });
    expect(failed(outside)).toEqual(["touchesOnlyTracks", "insideRegion"]);

    const chorus = evaluate(
      plan([
        variant("Chorus", step(laneAutomation("sec_c", "trk_drums", "track:trk_drums/gainDb"))),
      ]),
      { insideRegion: true },
    );
    expect(failed(chorus)).toEqual(["insideRegion"]);
    expect(chorus.checks.find((check) => check.name === "insideRegion")?.detail).toMatch(
      /outside the region/,
    );
  });

  it("treats a structural change as song-wide", () => {
    const result = evaluate(
      plan([variant("Remove", step({ op: "section.remove", sectionId: "sec_c", closeGap: true }))]),
      { insideRegion: true, distinctLeverTypes: 1 },
    );
    expect(failed(result)).toEqual(["insideRegion"]);
    expect(result.targets[0]?.levers.has("arrangement")).toBe(true);
  });

  it("allows a song-scoped variant to exceed the region", () => {
    const result = evaluate(plan([variant("Whole song", "song", step(trackFx("trk_bass")))]), {
      scopeSong: true,
      insideRegion: true,
    });
    expect(failed(result)).toEqual([]);
  });
});

describe("evaluateExpectations — structure", () => {
  it("checks op kinds, counts and lever diversity", () => {
    const result = evaluate(
      plan([
        variant(
          "Mix and move",
          step(
            trackFx("trk_drums", "fx_1"),
            {
              op: "automation.set",
              scope: { kind: "lane", sectionId: "sec_b", trackId: "trk_drums" },
              target: "fx:fx_1/drive",
              points: [{ tick: 0, value: 1, curve: "step" }],
            },
            { op: "clip.update", clipId: "clp_110", patch: { gainDb: -2 } },
            { op: "track.update", trackId: "trk_drums", patch: { pan: 0.2 } },
          ),
        ),
      ]),
      {
        minVariants: 1,
        maxVariants: 1,
        onlyOpKinds: ["fx.add", "automation.set", "clip.update", "track.update"],
        distinctLeverTypes: 4,
      },
    );
    expect(failed(result)).toEqual([]);

    const tooFew = evaluate(plan([variant("Only fx", step(trackFx("trk_drums")))]), {
      distinctLeverTypes: 2,
      onlyOpKinds: ["fx.add"],
    });
    expect(failed(tooFew)).toEqual(["distinctLeverTypes"]);
  });

  it("flags forbidden op kinds", () => {
    const result = evaluate(
      plan([variant("Delete", step({ op: "section.remove", sectionId: "sec_c", closeGap: true }))]),
      { forbiddenOpKinds: ["section.remove"] },
    );
    expect(failed(result)).toEqual(["forbiddenOpKinds"]);
  });

  it("finds a no-touch section anywhere in the ops", () => {
    const result = evaluate(
      plan([
        variant("Mute", step({ op: "track.update", trackId: "trk_drums", patch: { mute: true } })),
      ]),
      { noTouch: ["trk_drums"] },
    );
    expect(failed(result)).toEqual(["noTouch"]);
  });

  it("accepts a clarification with no variants", () => {
    const clarification: EditPlan = {
      planId: PLAN_ID,
      interpretation: "There are two ways to read that.",
      clarification: { question: "Louder or softer?", options: ["Louder", "Softer"] },
      variants: [],
      estimatedCredits: 0,
      estimatedSeconds: 0,
    };
    const result = evaluate(clarification, { asksClarification: true });
    expect(failed(result)).toEqual([]);
  });
});

describe("evaluateExpectations — content and wording", () => {
  it("reads notices for noticeContains and ignores them for forbiddenText", () => {
    const withNotice = plan(
      [variant("Warm", step(clipFx()))],
      ["I described Daft Punk as filtered disco house, tight drums."],
    );
    const result = evaluate(withNotice, {
      noticeContains: ["described"],
      forbiddenText: ["Daft Punk"],
    });
    expect(failed(result)).toEqual([]);

    const leaked: EditPlan = {
      ...withNotice,
      interpretation: "I'll give the drums a Daft Punk feel.",
    };
    expect(failed(evaluate(leaked, { forbiddenText: ["Daft Punk"] }))).toEqual(["forbiddenText"]);
  });

  it("checks containsText and interpretationExcludesDropped", () => {
    const loop = plan([
      variant(
        "Loop",
        step({ op: "section.resize", sectionId: "sec_c", lengthTicks: 61440, mode: "loop" }),
      ),
    ]);
    expect(failed(evaluate(loop, { containsText: ["loop", "section.resize"] }))).toEqual([]);

    const mentionsDropped: EditPlan = {
      ...plan([variant("Warm", step(clipFx()))]),
      interpretation: 'The "Dusty tape" variant is the one I would try.',
    };
    expect(
      failed(
        evaluate(
          mentionsDropped,
          { interpretationExcludesDropped: true },
          {
            dropped: ["Dusty tape"],
          },
        ),
      ),
    ).toEqual(["interpretationExcludesDropped"]);
    expect(
      failed(
        evaluate(plan([variant("Warm", step(clipFx()))]), {
          interpretationExcludesDropped: true,
        }),
      ),
    ).toEqual([]);

    const mentionsOption: EditPlan = {
      ...plan([variant("Warm", step(clipFx()))]),
      interpretation: "The third option warms the whole song instead.",
    };
    expect(
      failed(
        evaluate(
          mentionsOption,
          { interpretationExcludesDropped: true },
          { dropped: ["Whole-song warmth"] },
        ),
      ),
    ).toEqual(["interpretationExcludesDropped"]);
  });
});

describe("leverOf", () => {
  it("maps op names to lever families", () => {
    expect(leverOf("fx.add")).toBe("fx");
    expect(leverOf("automation.set")).toBe("automation");
    expect(leverOf("track.update")).toBe("mixer");
    expect(leverOf("clip.update")).toBe("clip");
    expect(leverOf("section.resize")).toBe("arrangement");
    expect(leverOf("tempo.set")).toBe("song");
  });
});

describe("overReaches", () => {
  const region: Region = { startTick: 0, endTick: 3840, tracks: ["trk_drums"] };
  const songVariant = variant("Song", "song", step(trackFx("trk_bass")));
  const plainVariant = variant("Plain", step(trackFx("trk_drums")));

  it("accepts anything in a song-scoped variant", () => {
    expect(
      overReaches(
        { songWide: true, tracks: new Set(["trk_bass"]), spans: [] },
        songVariant,
        region,
      ),
    ).toBe(false);
  });

  it("flags outside tracks, outside spans and structural changes", () => {
    expect(
      overReaches(
        { songWide: false, tracks: new Set(["trk_bass"]), spans: [] },
        plainVariant,
        region,
      ),
    ).toBe(true);
    expect(
      overReaches(
        { songWide: false, tracks: [], spans: [{ startTick: 3840, endTick: 7680 }] },
        plainVariant,
        region,
      ),
    ).toBe(true);
    expect(overReaches({ songWide: true, tracks: [], spans: [] }, plainVariant, region)).toBe(true);
  });

  it("accepts a change inside the region", () => {
    expect(
      overReaches(
        {
          songWide: false,
          tracks: new Set(["trk_drums"]),
          spans: [{ startTick: 0, endTick: 3840 }],
        },
        plainVariant,
        region,
      ),
    ).toBe(false);
  });
});
