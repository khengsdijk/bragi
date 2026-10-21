import { readdirSync, readFileSync } from "node:fs";

import { type ApiClient, PlannerApiError } from "@bragi/api-client";
import { type EngineHost, type EngineState, parseMigrations } from "@bragi/platform";
import { createMemoryPlatform } from "@bragi/platform/testing";
import type { EditPlan, Op, OpBatch, PlanRequest, PlanVariant } from "@bragi/schemas";
import { describe, expect, it, vi } from "vitest";
import { createAudition } from "../../audition/state/audition.js";
import { createHistory } from "../../history/state/history.js";
import { loadTestModel } from "../../song/__tests__/fixtures.js";
import { buildDemoProject, fakeAssetHash, SHORT_DEMO } from "../../song/api/demo-song.js";
import { sectionSpansSec } from "../../song/api/section-time.js";
import { createEngineController } from "../../song/state/engine-controller.js";
import { createSongStore } from "../../song/state/song-store.js";
import { createPlanner } from "../state/planner.js";

const MIGRATIONS_DIR = new URL("../../../../../schemas/sqlite/migrations/", import.meta.url);
const migrations = parseMigrations(
  Object.fromEntries(
    readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => [name, readFileSync(new URL(name, MIGRATIONS_DIR), "utf8")]),
  ),
);

const NOW = new Date("2026-10-20T12:00:00.000Z");

function fakeHost() {
  const host = {
    init: vi.fn(async () => {}),
    loadDocument: vi.fn(async () => {}),
    applyDelta: vi.fn(),
    setPreview: vi.fn(),
    transport: vi.fn(),
    warm: vi.fn(async (_slot: number, _doc: unknown) => {}),
    release: vi.fn((_slot: number) => {}),
    audition: vi.fn((_slot: number) => {}),
    render: vi.fn(),
    peaks: vi.fn(),
    spectrogram: vi.fn(),
    onState: vi.fn((_cb: (state: EngineState) => void) => () => {}),
    onEvent: vi.fn(() => () => {}),
    dispose: vi.fn(async () => {}),
  } satisfies EngineHost;
  return host;
}

function variant(label: string, trackId: string, gainDb: number): PlanVariant {
  const ops: [Op, ...Op[]] = [{ op: "track.update", trackId, patch: { gainDb } }];
  return { label, description: label, steps: [{ kind: "ops", ops }] };
}

function planWith(variants: EditPlan["variants"], label = "plan"): EditPlan {
  return {
    planId: "pln_01JTESTPLANNER000000000",
    interpretation: `I'll ${label}.`,
    variants,
    estimatedCredits: 0,
    estimatedSeconds: 0,
  };
}

function emptyPlan(): EditPlan {
  return planWith([]);
}

function analysis() {
  return {
    energy: { values: Float32Array.from({ length: 64 }, () => 0.5), hopSec: 1 },
    chords: [],
    ribbons: {
      trk_bass: { rms: { values: Float32Array.from({ length: 64 }, () => 1), hopSec: 1 } },
    },
  };
}

async function setup(result: () => Promise<EditPlan>) {
  const platform = await createMemoryPlatform(migrations);
  const model = await loadTestModel();
  const built = buildDemoProject(SHORT_DEMO, {
    assetFor: (key) => fakeAssetHash(`planner:${key}`),
    projectId: "PLANNERTEST0000000000001",
  });
  await platform.localDb.run(
    "INSERT OR IGNORE INTO projects (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
    [built.project.id, built.project.meta.title, built.project.meta.createdAt, NOW.toISOString()],
  );
  const songStore = createSongStore(model);
  songStore.load(built.project, built.assets);
  const history = createHistory({
    platform,
    songStore,
    model,
    projectId: built.project.id,
    now: () => NOW,
  });
  await history.load();
  const host = fakeHost();
  const controller = createEngineController({
    createEngine: async () => host,
    document: () => songStore.store.getState().doc,
    durationSec: () => 32,
  });
  const announcements: string[] = [];
  const audition = createAudition({
    controller,
    history,
    document: () => songStore.store.getState().doc,
    onOutcome: (outcome) => {
      if (outcome?.ok) controller.commit(outcome.commit, outcome.doc);
    },
    onAnnounce: (message) => announcements.push(message),
  });
  const calls: PlanRequest[] = [];
  const client = {
    plan: vi.fn(async (request: PlanRequest) => {
      calls.push(request);
      return result();
    }),
  } satisfies Pick<ApiClient, "plan">;
  const planner = createPlanner({
    client,
    songStore,
    model,
    analysis,
    history,
    audition,
    onAnnounce: (message) => announcements.push(message),
    now: () => NOW,
    newGroupId: () => "grp_planner",
  });
  const spans = sectionSpansSec(model, songStore.handle() ?? 0);
  return { songStore, history, audition, planner, calls, client, announcements, spans };
}

describe("the planner prompt", () => {
  it("turns a lasso, a request and three variants into candidate ideas", async () => {
    const { songStore, history, audition, planner, calls, announcements, spans } = await setup(
      async () =>
        planWith(
          [
            variant("Subtle", "trk_bass", -1),
            variant("Dusty tape", "trk_bass", -3),
            variant("Stripped", "trk_bass", -6),
          ],
          "make the bass quieter",
        ),
    );
    planner.openForLasso({
      startSec: 1.1,
      endSec: 3.2,
      trackIds: ["trk_bass"],
      altKey: false,
    });
    expect(planner.store.getState().target?.region).toEqual({
      startTick: 1920,
      endTick: 5760,
      tracks: ["trk_bass"],
    });

    await planner.submit("make the bass quieter");

    const request = calls[0];
    if (request === undefined) throw new Error("no request");
    expect(request.doc.tracks.map((track) => track.id)).toEqual(
      songStore.store.getState().doc?.tracks.map((track) => track.id),
    );
    expect(request.region).toEqual({ startTick: 1920, endTick: 5760, tracks: ["trk_bass"] });
    expect(request.uiContext).toEqual({
      view: "song",
      selectedTrackIds: ["trk_bass"],
      selectedSectionIds: [spans[0]?.id ?? ""],
    });
    expect(request.variantCount).toBe(3);
    expect(request.explain).toBeUndefined();
    expect(request.sectionFeatures?.length).toBeGreaterThan(0);

    const candidates = [...history.store.getState().commits.values()].filter(
      (commit) => commit.state === "candidate",
    );
    expect(candidates.map((commit) => commit.label)).toEqual(["Subtle", "Dusty tape", "Stripped"]);
    expect(candidates.every((commit) => commit.candidateGroup === "grp_planner")).toBe(true);
    const group = audition.store.getState().group;
    expect(group?.candidates.map((candidate) => candidate.label)).toEqual([
      "Subtle",
      "Dusty tape",
      "Stripped",
    ]);
    const state = planner.store.getState();
    expect(state.phase).toBe("done");
    expect(state.candidates).toBe(3);
    expect(state.interpretation).toContain("make the bass quieter");
    expect(announcements.at(-1)).toBe("3 version ideas ready");
  });

  it("asks a clarification and resubmits with the chosen option appended", async () => {
    const clarify: EditPlan = {
      ...emptyPlan(),
      interpretation: "The drums could go two ways.",
      clarification: {
        question: "What should the drums do?",
        options: ["Keep the groove", "Half-time feel"],
      },
    };
    const plan = planWith([variant("Subtle", "trk_bass", -1), variant("Deeper", "trk_bass", -3)]);
    let answer = 0;
    const harness = await setup(async () => {
      const next = answer === 0 ? clarify : plan;
      answer += 1;
      return next;
    });
    harness.planner.openRegion({ startTick: 1920, endTick: 5760, tracks: ["trk_bass"] }, "Bass");
    await harness.planner.submit("quieter bass");
    expect(harness.planner.store.getState().phase).toBe("clarify");
    expect(harness.planner.store.getState().clarification).toEqual({
      question: "What should the drums do?",
      options: ["Keep the groove", "Half-time feel"],
    });
    expect(harness.audition.store.getState().group).toBeNull();

    await harness.planner.chooseClarification("Keep the groove");
    expect(harness.calls[1]?.prompt).toBe("quieter bass\nKeep the groove");
    expect(harness.planner.store.getState().phase).toBe("done");
    expect(harness.audition.store.getState().group?.candidates).toHaveLength(2);
  });

  it("shows a plain message when the planner is unavailable or has no idea", async () => {
    const unavailable = await setup(async () => {
      throw new PlannerApiError("PLANNER_UNAVAILABLE", 503);
    });
    unavailable.planner.openRegion(
      { startTick: 1920, endTick: 5760, tracks: ["trk_bass"] },
      "Bass",
    );
    await unavailable.planner.submit("quieter bass");
    expect(unavailable.planner.store.getState().phase).toBe("error");
    expect(unavailable.planner.store.getState().message).toBe(
      "The AI planner isn't set up on this computer yet.",
    );

    const empty = await setup(async () => emptyPlan());
    empty.planner.openRegion({ startTick: 1920, endTick: 5760, tracks: ["trk_bass"] }, "Bass");
    await empty.planner.submit("do something impossible");
    expect(empty.planner.store.getState().phase).toBe("error");
    expect(empty.planner.store.getState().message).toBe("I couldn't find a way to do that here.");
    expect(empty.audition.store.getState().group).toBeNull();
  });

  it("does not open a second candidate group", async () => {
    const { history, audition, planner, client } = await setup(async () =>
      planWith([variant("Subtle", "trk_bass", -1)]),
    );
    const batches: OpBatch[] = [
      {
        id: "bat_existing",
        author: { kind: "ai", planId: "pln_existing", model: "test" },
        label: "Existing",
        ops: [{ op: "track.update", trackId: "trk_bass", patch: { gainDb: -2 } }],
        createdAt: NOW.toISOString(),
      },
    ];
    await history.addCandidates(batches, "grp_existing");
    await audition.openCandidates({ group: "grp_existing", prompt: "existing" });

    planner.openRegion({ startTick: 0, endTick: 1920, tracks: ["trk_bass"] }, "Bass");
    await planner.submit("quieter bass");
    expect(planner.store.getState().phase).toBe("error");
    expect(planner.store.getState().message).toBe(
      "Accept or discard the open version ideas first.",
    );
    expect(client.plan).not.toHaveBeenCalled();
  });
});
