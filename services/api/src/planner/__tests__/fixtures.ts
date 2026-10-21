/**
 * Planner test fixtures: a small two-track, three-section song and request helpers.
 *
 * The ids satisfy the schema patterns and every section is one bar (3840 ticks) so region maths
 * is easy to read. No audio is involved; the ops are track and clip edits.
 */
import type {
  Clip,
  EditPlan,
  LaneMap,
  Op,
  PlanRequest,
  PlanVariant,
  Project,
  Region,
} from "@bragi/schemas";

const ASSET = `sha256:${"1".repeat(64)}`;
const DATE = "2026-10-18T12:00:00Z";
const BAR = 3840;

/** A clip on one lane. */
function clip(id: string, start: number): Clip {
  return {
    id,
    asset: ASSET,
    srcStart: 0,
    srcEnd: 48000,
    start,
    warp: {
      mode: "beatgrid" as const,
      anchors: [
        { srcSample: 0, tick: start },
        { srcSample: 48000, tick: start + 1920 },
      ],
    },
    gainDb: 0,
    pitchSemitones: 0,
    fadeInTicks: 0,
    fadeOutTicks: 0,
    fadeCurve: "equal_power" as const,
    provenance: { kind: "user" as const, createdAt: DATE },
  };
}

/** Builds the fixture song. `locked` marks the second section locked. */
export function testProject(options: { locked?: boolean } = {}): Project {
  const lanes = (track: string, prefix: string, start: number): LaneMap => ({
    [track]: { clips: [clip(`clp_${prefix}`, start)], automation: [] },
  });
  return {
    schemaVersion: 1,
    id: "prj_01JAB3QK7M9P2V6XWN0T4Y8ZB5",
    meta: { title: "Planner fixture", createdAt: DATE, tags: [] },
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
      {
        id: "trk_bass",
        name: "Bass",
        role: "bass",
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
          kind: "intro",
          label: "Intro",
          lengthTicks: BAR,
          transitionIn: { kind: "cut", lengthTicks: 0 },
          lanes: {
            ...lanes("trk_drums", "a1", 0),
            ...lanes("trk_bass", "a2", 0),
          },
        },
        {
          id: "sec_b",
          kind: "verse",
          label: "Verse",
          lengthTicks: BAR,
          transitionIn: { kind: "cut", lengthTicks: 0 },
          ...(options.locked === true ? { locked: true } : {}),
          lanes: {
            ...lanes("trk_drums", "b1", 0),
            ...lanes("trk_bass", "b2", 0),
          },
        },
        {
          id: "sec_c",
          kind: "chorus",
          label: "Chorus",
          lengthTicks: BAR,
          transitionIn: { kind: "cut", lengthTicks: 0 },
          lanes: {
            ...lanes("trk_drums", "c1", 0),
            ...lanes("trk_bass", "c2", 0),
          },
        },
      ],
      master: { fx: [], automation: [], gainDb: 0 },
    },
  };
}

/** The first section, drums only. */
export const FIRST_SECTION_DRUMS: Region = {
  startTick: 0,
  endTick: BAR,
  tracks: ["trk_drums"],
};

/** A request with the fixture document and the first section selected. */
export function testRequest(overrides: Partial<PlanRequest> = {}): PlanRequest {
  return {
    doc: testProject(),
    prompt: "make the drums a little warmer",
    region: FIRST_SECTION_DRUMS,
    uiContext: {
      view: "moment",
      selectedTrackIds: ["trk_drums"],
      selectedSectionIds: ["sec_a"],
    },
    ...overrides,
  };
}

/** An `fx.add` op on a track. */
export function trackFx(trackId: string, fxId = "fx_01"): Op {
  return {
    op: "fx.add",
    scope: { kind: "track", trackId },
    fx: { id: fxId, type: "eq3", params: { lowDb: 2 }, bypass: false },
  };
}

/** A one-step variant. */
export function opsVariant(label: string, ops: [Op, ...Op[]], scope?: "song"): PlanVariant {
  return {
    label,
    description: `${label} variant`,
    steps: [{ kind: "ops", ops }],
    ...(scope === undefined ? {} : { scope }),
  };
}

/** A draft plan as the model returns it (no `planId` or estimates). */
export function draftPlan(variants: PlanVariant[], interpretation = "A small change."): unknown {
  return { interpretation, variants };
}

/** A full `EditPlan` for route tests. */
export function routePlan(): EditPlan {
  return {
    planId: "pln_01JAB5H7K8M9N0P1Q2R3S4T5V6",
    interpretation: "A small change.",
    variants: [opsVariant("Subtle", [trackFx("trk_drums")])],
    estimatedCredits: 0,
    estimatedSeconds: 0,
  };
}
