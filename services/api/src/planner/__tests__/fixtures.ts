/**
 * Planner test fixtures: a small two-track, three-section song and request helpers.
 *
 * The ids satisfy the schema patterns and every section is one bar (3840 ticks) so region maths
 * is easy to read. No audio is involved; the ops are track and clip edits.
 */
import type {
  Clip,
  ContextSpec,
  EditPlan,
  LaneMap,
  Op,
  Placement,
  PlanRequest,
  PlanVariant,
  Project,
  Region,
  SmoothToolList,
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

/** Builds the fixture song. `locked` marks the second section locked; `analysedKey` adds the analysis summary. */
export function testProject(options: { locked?: boolean; analysedKey?: string } = {}): Project {
  const lanes = (track: string, prefix: string, start: number): LaneMap => ({
    [track]: { clips: [clip(`clp_${prefix}`, start)], automation: [] },
  });
  return {
    schemaVersion: 1,
    id: "prj_01JAB3QK7M9P2V6XWN0T4Y8ZB5",
    meta: { title: "Planner fixture", createdAt: DATE, tags: [] },
    sources: [],
    analyses:
      options.analysedKey === undefined
        ? {}
        : {
            src_a: {
              profile: "standard",
              status: { rhythm: "done", tag: "done" },
              blobs: {},
              summary: {
                bpm: 120,
                key: options.analysedKey,
                durationSec: 4,
                genres: [],
                moods: [],
              },
            },
          },
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

/** What a fixture generate step can vary. */
export interface GenerateStepOptions {
  id?: string;
  capability?: string;
  params?: Record<string, unknown>;
  context?: ContextSpec;
  placement?: Placement;
  /** A leading ops step, for a variant that also edits the song directly. */
  ops?: [Op, ...Op[]];
  smooth?: Region;
  scope?: "song";
}

/**
 * A generate + apply_generated variant as the model returns it.
 *
 * The default inpaint fills the second of the fixture's three one-bar sections: the gap is
 * 3840–7680 and the server derives the two context ranges from the request's region.
 */
export function generationVariant(label: string, options: GenerateStepOptions = {}): PlanVariant {
  const id = options.id ?? "g1";
  const capability = options.capability ?? "generate.inpaint";
  const region = options.placement?.region ?? {
    startTick: BAR,
    endTick: BAR * 2,
    tracks: ["trk_drums"],
  };
  const steps: PlanVariant["steps"][number][] = [
    ...(options.ops === undefined ? [] : [{ kind: "ops" as const, ops: options.ops }]),
    {
      kind: "generate",
      id,
      capability,
      params: options.params ?? {
        context: { key: { tonic: "A", mode: "minor" } },
        tier: "preview",
        n: 2,
        prompt: "a dusty drum fill",
      },
      context: options.context ?? { tracks: "all" },
    },
    {
      kind: "apply_generated",
      from: id,
      placement: options.placement ?? { region, trackId: "trk_drums", mode: "replace" },
    },
    ...(options.smooth === undefined
      ? []
      : [
          {
            kind: "smooth" as const,
            region: options.smooth,
            tools: ["crossfade"] as SmoothToolList,
          },
        ]),
  ];
  const [first, ...rest] = steps;
  if (first === undefined) throw new Error("a variant needs a step");
  return {
    label,
    description: `${label} variant`,
    steps: [first, ...rest],
    ...(options.scope === undefined ? {} : { scope: options.scope }),
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
