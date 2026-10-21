/**
 * A mixed planner plan: ops-only variants stay instant, the generative variant executes through
 * `POST /v1/plans/{id}/execute` and streams in as one more idea (06 §5; M2 demo 4).
 *
 * The fake API answers execute with a job, the fake socket delivers its partial with a
 * `GenerateFillResult`, and the controller builds the candidate from the variant's ops, the
 * `apply_generated` placement and the compiled `smooth` step. Accept queues analysis and an HQ
 * re-render, like every other generation flow.
 */
import type { EditPlan, GenerateFillResult } from "@bragi/schemas";
import { describe, expect, it, vi } from "vitest";

import { sha256Hex } from "../../analysis/api/hash.js";
import { type Audition, createAudition } from "../../audition/state/audition.js";
import {
  BAR_SAMPLES,
  CONTEXT_BYTES,
  createFakeApi,
  NOW,
  openSong,
  type SongFixture,
  TICKS_PER_BAR,
} from "../../generation/__tests__/generation-fixture.js";
import { candidateBatches } from "../candidates.js";
import { createPlannerGeneration, smoothOps } from "../planner-generation.js";

const PLAN_ID = "pln_01JTEST000000000000000000";
const GAP = { startTick: 4 * TICKS_PER_BAR, endTick: 6 * TICKS_PER_BAR };
const BOUNDARY = 6 * TICKS_PER_BAR;

function mixedPlan(): EditPlan {
  return {
    planId: PLAN_ID,
    interpretation: "I'll lower the drums a little, or generate a fill.",
    estimatedCredits: 2,
    estimatedSeconds: 20,
    variants: [
      {
        label: "Subtle",
        description: "A little quieter.",
        steps: [
          {
            kind: "ops",
            ops: [{ op: "track.update", trackId: "trk_drums", patch: { gainDb: -1 } }],
          },
        ],
      },
      {
        label: "Generated fill",
        description: "Fill the gap with new drums.",
        steps: [
          {
            kind: "generate",
            id: "g1",
            capability: "generate.inpaint",
            params: { gapBars: 2, overlapBars: 1, tier: "preview", n: 3, prompt: "drum fill" },
            context: {
              before: { startTick: 2 * TICKS_PER_BAR, endTick: GAP.startTick },
              after: { startTick: GAP.endTick, endTick: 8 * TICKS_PER_BAR },
              tracks: "all",
            },
          },
          {
            kind: "apply_generated",
            from: "g1",
            placement: { region: { ...GAP, tracks: ["trk_drums"] }, mode: "replace" },
          },
          {
            kind: "smooth",
            region: { startTick: BOUNDARY, endTick: 10 * TICKS_PER_BAR, tracks: "all" },
            tools: ["crossfade", "loudness_match"],
          },
        ],
      },
    ],
  };
}

interface Harness {
  readonly song: SongFixture;
  readonly fake: ReturnType<typeof createFakeApi>;
  readonly generation: ReturnType<typeof createPlannerGeneration>;
  readonly audition: Audition;
  readonly announced: string[];
  readonly renderContext: ReturnType<typeof vi.fn>;
  candidate(
    index: number,
    patch?: Partial<GenerateFillResult>,
  ): Promise<{ assetHash: string; blobHash: string }>;
}

async function harness(): Promise<Harness> {
  const song = await openSong();
  const fake = createFakeApi({
    execute: async () => ({
      jobs: [
        {
          variant: 1,
          stepId: "g1",
          jobId: "job_PLAN01",
          capability: "generate.inpaint",
          status: "queued",
          estimatedCredits: 2,
        },
      ],
    }),
  });
  const announced: string[] = [];
  let audition: Audition | null = null;
  const renderContext = vi.fn(async () => CONTEXT_BYTES);
  const generation = createPlannerGeneration({
    platform: song.platform,
    api: fake.api,
    realtime: fake.realtime,
    songStore: song.songStore,
    history: song.history,
    renderContext: renderContext as never,
    audition: {
      open: (options) => audition?.openCandidates(options) ?? Promise.resolve(false),
      setQueue: (status) => audition?.setQueue(status),
      isOpen: () => audition?.store.getState().group != null,
    },
    fetch: fake.fetch,
    hash: sha256Hex,
    now: () => NOW,
    onAnnounce: (message) => announced.push(message),
    onCommit: (commit, doc) => song.controller.commit(commit, doc),
  });
  audition = createAudition({
    controller: song.controller,
    history: song.history,
    document: () => song.songStore.store.getState().doc,
    source: generation.source,
    onAccept: (candidateId) => generation.accepted(candidateId),
    onDiscard: (group) => generation.discarded(group),
    onOutcome: (outcome) => {
      if (outcome?.ok) song.controller.commit(outcome.commit, outcome.doc);
    },
    onAnnounce: (message) => announced.push(message),
    setTimeout: () => {},
  });

  async function candidate(
    index: number,
    patch: Partial<GenerateFillResult> = {},
  ): Promise<{ assetHash: string; blobHash: string }> {
    const assetHash = await fake.put(`planner-candidate-${index}`);
    const result: GenerateFillResult = {
      schemaVersion: 1,
      index,
      asset: assetHash,
      seed: 300 + index,
      model: "fake",
      modelVersion: "1.0.0",
      passed: true,
      qualityWarning: false,
      seamScore: 0.2,
      endSeamScore: 0.3,
      tempoError: 0.001,
      startOffsetSamples: -BAR_SAMPLES,
      endOffsetSamples: BAR_SAMPLES,
      steps: [{ step: "sanity", passed: true, skipped: false, metrics: {} }],
      ...patch,
    };
    const blobHash = await fake.put(JSON.stringify(result));
    return { assetHash, blobHash };
  }

  return {
    song,
    fake,
    generation,
    get audition() {
      if (audition === null) throw new Error("no audition");
      return audition;
    },
    announced,
    renderContext,
    candidate,
  };
}

/** The candidate commits the plan's generative variant made. */
function generatedCommits(h: Harness) {
  return [...h.song.history.store.getState().commits.values()].filter(
    (commit) => commit.state === "candidate" && commit.label === "Generated fill",
  );
}

/** Lets the queued candidate chain finish before asserting it added nothing more. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25));
}

describe("the planner's generation execute", () => {
  it("adds instant ideas, uploads the contexts and executes the generative variant", async () => {
    const h = await harness();
    const plan = mixedPlan();
    const started = await h.generation.execute({
      plan,
      prompt: "make the drums interesting",
      region: { startTick: GAP.startTick, endTick: GAP.endTick, tracks: ["trk_drums"] },
      opsBatches: candidateBatches(plan, { now: NOW }),
    });
    expect(started).toBe(true);

    // The ops-only variant is a candidate immediately; the bar shows the generative one as queued.
    const instant = [...h.song.history.store.getState().commits.values()].filter(
      (commit) => commit.state === "candidate",
    );
    expect(instant.map((commit) => commit.label)).toEqual(["Subtle"]);
    expect(h.audition.store.getState().group?.id).toBe(PLAN_ID);
    expect(h.audition.store.getState().group?.queue).toEqual({ kind: "queued" });
    expect(h.fake.executes).toHaveLength(1);
    expect(h.fake.executes[0]?.planId).toBe(PLAN_ID);
    expect(Object.keys(h.fake.executes[0]?.request.contexts ?? {})).toEqual(["g1"]);
    expect(Object.keys(h.fake.executes[0]?.request.contexts.g1 ?? {}).sort()).toEqual([
      "after",
      "before",
    ]);
    expect(h.renderContext).toHaveBeenCalledTimes(2);
    expect(h.fake.realtime.topics()).toContain("job:job_PLAN01");

    // Progress fills the single queue chip, as an extend does (07 §6).
    h.fake.progress("job_PLAN01", 0.4);
    expect(h.audition.store.getState().group?.queue).toEqual({ kind: "generating", pct: 0.4 });
  });

  it("publishes the generative idea with its placement and compiled smooth step", async () => {
    const h = await harness();
    const plan = mixedPlan();
    await h.generation.execute({
      plan,
      prompt: "make the drums interesting",
      region: { startTick: GAP.startTick, endTick: GAP.endTick, tracks: ["trk_drums"] },
      opsBatches: candidateBatches(plan, { now: NOW }),
    });
    const candidate = await h.candidate(0);
    h.fake.partial("job_PLAN01", 0, candidate.assetHash, candidate.blobHash);
    await vi.waitFor(() => {
      expect(h.audition.store.getState().group?.candidates).toHaveLength(2);
    });
    // The generative idea is playable as soon as it lands.
    expect(h.audition.store.getState().warm).toContain(2);

    const commits = [...h.song.history.store.getState().commits.values()].filter(
      (commit) => commit.state === "candidate" && commit.label === "Generated fill",
    );
    expect(commits).toHaveLength(1);
    const snapshot = await h.song.history.readSnapshot(commits[0]?.id ?? "");
    const source = snapshot?.sources.find(
      (entry) => entry.kind === "generated" && entry.placement !== undefined,
    );
    expect(source?.placement?.range).toEqual({ startTick: 7_680, endTick: 15_360 });
    const generated = snapshot?.tracks.find((track) => track.role === "generated");
    const clip =
      generated === undefined
        ? undefined
        : snapshot?.arrangement.sections[1]?.lanes[generated.id]?.clips[0];
    expect(clip?.asset).toBe(candidate.assetHash);
    // The smooth step compiled to a one-beat crossfade on the boundary it named.
    expect(snapshot?.arrangement.sections[2]?.transitionIn).toEqual({
      kind: "crossfade",
      lengthTicks: 960,
    });

    // Accept: analysis and an HQ re-render from the same rendered contexts.
    const slot = h.audition.store
      .getState()
      .group?.candidates.find((entry) => entry.label === "Generated fill")?.slot;
    expect(slot).toBe(2);
    if (slot !== undefined) expect(h.audition.select(slot)).toBe(true);
    await h.audition.accept();
    await vi.waitFor(() => {
      expect(h.fake.analysed).toEqual([{ hash: candidate.assetHash, profile: "standard" }]);
      expect(h.fake.submits).toHaveLength(1);
    });
    expect(h.fake.submits[0]?.body).toMatchObject({
      capability: "generate.inpaint",
      priority: "background",
    });
    expect(h.fake.submits[0]?.body.params).toMatchObject({ tier: "hq", n: 1 });
  });

  it("publishes a rejected candidate only when the job ends without a passing one", async () => {
    const h = await harness();
    const plan = mixedPlan();
    await h.generation.execute({
      plan,
      prompt: "fill",
      region: { startTick: GAP.startTick, endTick: GAP.endTick, tracks: ["trk_drums"] },
      opsBatches: candidateBatches(plan, { now: NOW }),
    });
    const candidate = await h.candidate(0);
    const rejected: GenerateFillResult = {
      ...(JSON.parse(
        new TextDecoder().decode(h.fake.store.get(candidate.blobHash) ?? new Uint8Array()),
      ) as GenerateFillResult),
      passed: false,
      qualityWarning: true,
    };
    const blobHash = await h.fake.put(JSON.stringify(rejected));
    h.fake.partial("job_PLAN01", 0, candidate.assetHash, blobHash);
    await vi.waitFor(() => {
      expect(h.audition.store.getState().group?.candidates).toHaveLength(1);
    });
    h.fake.realtime.emit({
      t: "job.completed",
      jobId: "job_PLAN01",
      outputs: { assets: {}, blobs: {} },
    });
    await vi.waitFor(() => {
      expect(h.audition.store.getState().group?.candidates).toHaveLength(2);
    });
    const warned = h.audition.store
      .getState()
      .group?.candidates.find((entry) => entry.label === "Generated fill");
    expect(warned?.warning).toBe("This one might not blend perfectly");
  });

  it("reads the whole candidate list of a completed-only job (a result-cache hit)", async () => {
    const h = await harness();
    const plan = mixedPlan();
    await h.generation.execute({
      plan,
      prompt: "fill",
      region: { startTick: GAP.startTick, endTick: GAP.endTick, tracks: ["trk_drums"] },
      opsBatches: candidateBatches(plan, { now: NOW }),
    });
    // No partials at all: the cache hit publishes three candidates with the completion.
    const first = await h.candidate(0, { passed: false });
    const second = await h.candidate(1, { passed: true });
    const third = await h.candidate(2, { passed: true });
    h.fake.realtime.emit({
      t: "job.completed",
      jobId: "job_PLAN01",
      outputs: {
        assets: {
          candidate_0: first.assetHash,
          candidate_1: second.assetHash,
          candidate_2: third.assetHash,
        },
        blobs: {
          candidate_0: first.blobHash,
          candidate_1: second.blobHash,
          candidate_2: third.blobHash,
        },
      },
    });
    await vi.waitFor(() => {
      expect(generatedCommits(h)).toHaveLength(1);
    });
    // The first passing candidate wins; the third is not published on top of it.
    await settle();
    expect(generatedCommits(h)).toHaveLength(1);

    const snapshot = await h.song.history.readSnapshot(generatedCommits(h)[0]?.id ?? "");
    const generated = snapshot?.tracks.find((track) => track.role === "generated");
    const clips =
      generated === undefined
        ? []
        : (snapshot?.arrangement.sections.flatMap(
            (section) => section.lanes[generated.id]?.clips ?? [],
          ) ?? []);
    expect(clips.map((clip) => clip.asset)).toEqual([second.assetHash]);
  });

  it("publishes nothing twice when completed repeats a streamed candidate", async () => {
    const h = await harness();
    const plan = mixedPlan();
    await h.generation.execute({
      plan,
      prompt: "fill",
      region: { startTick: GAP.startTick, endTick: GAP.endTick, tracks: ["trk_drums"] },
      opsBatches: candidateBatches(plan, { now: NOW }),
    });
    const first = await h.candidate(0, { passed: true });
    const second = await h.candidate(1, { passed: true });
    const third = await h.candidate(2, { passed: true });
    h.fake.partial("job_PLAN01", 0, first.assetHash, first.blobHash);
    await vi.waitFor(() => {
      expect(generatedCommits(h)).toHaveLength(1);
    });

    // The normal streaming path: `completed` lists every candidate, including the published one.
    h.fake.realtime.emit({
      t: "job.completed",
      jobId: "job_PLAN01",
      outputs: {
        assets: {
          candidate_0: first.assetHash,
          candidate_1: second.assetHash,
          candidate_2: third.assetHash,
        },
        blobs: {
          candidate_0: first.blobHash,
          candidate_1: second.blobHash,
          candidate_2: third.blobHash,
        },
      },
    });
    await settle();
    expect(generatedCommits(h)).toHaveLength(1);
    expect(h.audition.store.getState().group?.candidates).toHaveLength(2);
  });
});

describe("smooth step compilation", () => {
  it("sets a crossfade on every boundary in the region and ignores the other tools", () => {
    const doc = {
      arrangement: {
        timebase: { ppq: 960 },
        sections: [
          { id: "sec_a", lengthTicks: 3_840 },
          { id: "sec_b", lengthTicks: 3_840 },
          { id: "sec_c", lengthTicks: 3_840 },
        ],
      },
    } as never;
    const ops = smoothOps(
      {
        kind: "smooth",
        region: { startTick: 3_840, endTick: 11_520, tracks: "all" },
        tools: ["crossfade", "loudness_match", "beat_align"],
      },
      doc,
    );
    expect(ops).toEqual([
      {
        op: "section.set_transition",
        sectionId: "sec_b",
        transition: { kind: "crossfade", lengthTicks: 960 },
      },
      {
        op: "section.set_transition",
        sectionId: "sec_c",
        transition: { kind: "crossfade", lengthTicks: 960 },
      },
    ]);
  });
});
