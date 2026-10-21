/**
 * The Fill gap flow end to end (09 §4.3; 07 §4.8).
 *
 * A fake API, socket and context render: the test erases two bars, renders both sides of the gap,
 * submits `generate.inpaint`, places a candidate through `fillPlacement`, accepts it with analysis
 * and an HQ re-render, and discards another. The document still goes through the real
 * `bragi-model` wasm and the history store.
 */

import type { GenerateFillResult } from "@bragi/schemas";
import { describe, expect, it, vi } from "vitest";
import { type Audition, createAudition } from "../../audition/state/audition.js";

import { createFillGapFlow, type FillGapFlow } from "../state/fill-flow.js";
import {
  BAR_SAMPLES,
  CONTEXT_BYTES,
  createFakeApi,
  flowDeps,
  openSong,
  type SongFixture,
  TICKS_PER_BAR,
} from "./generation-fixture.js";

const GAP = { startTick: 2 * TICKS_PER_BAR, endTick: 4 * TICKS_PER_BAR };

interface Harness {
  readonly song: SongFixture;
  readonly fake: ReturnType<typeof createFakeApi>;
  readonly flow: FillGapFlow;
  readonly audition: Audition;
  readonly announced: string[];
  readonly errors: string[];
  readonly renderContext: ReturnType<typeof vi.fn>;
  candidate(index: number): Promise<{ assetHash: string; blobHash: string }>;
}

async function harness(): Promise<Harness> {
  const song = await openSong();
  const fake = createFakeApi();
  const announced: string[] = [];
  const errors: string[] = [];
  let audition: Audition | null = null;
  const renderContext = vi.fn(async () => CONTEXT_BYTES);
  const flow = createFillGapFlow(
    flowDeps(song, fake, {
      renderContext: renderContext as never,
      audition: {
        open: (options) => audition?.openCandidates(options) ?? Promise.resolve(false),
        setQueue: (status) => audition?.setQueue(status),
        isOpen: () => audition?.store.getState().group != null,
      },
      onAnnounce: (message) => announced.push(message),
      onError: (message) => errors.push(message),
      onCommit: (commit, doc) => song.controller.commit(commit, doc),
    }),
  );
  audition = createAudition({
    controller: song.controller,
    history: song.history,
    document: () => song.songStore.store.getState().doc,
    source: flow.source,
    onAccept: (candidateId) => flow.accepted(candidateId),
    onDiscard: (group) => flow.discarded(group),
    onOutcome: (outcome) => {
      if (outcome?.ok) song.controller.commit(outcome.commit, outcome.doc);
    },
    onAnnounce: (message) => announced.push(message),
    setTimeout: () => {},
  });

  async function candidate(index: number): Promise<{ assetHash: string; blobHash: string }> {
    const assetHash = await fake.put(`fill-candidate-${index}`);
    const result: GenerateFillResult = {
      schemaVersion: 1,
      index,
      asset: assetHash,
      seed: 100 + index,
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
    };
    const blobHash = await fake.put(JSON.stringify(result));
    return { assetHash, blobHash };
  }

  return {
    song,
    fake,
    flow,
    get audition() {
      if (audition === null) throw new Error("no audition");
      return audition;
    },
    announced,
    errors,
    renderContext,
    candidate,
  };
}

/** The candidate commits of the flow's group. */
function candidateCommits(h: Harness) {
  return [...h.song.history.store.getState().commits.values()].filter(
    (commit) => commit.state === "candidate",
  );
}

/** Emits a completion whose outputs list every candidate, as a result-cache hit does. */
function emitCompleted(
  h: Harness,
  jobId: string,
  candidates: readonly { readonly assetHash: string; readonly blobHash: string }[],
): void {
  const assets: Record<string, string> = {};
  const blobs: Record<string, string> = {};
  candidates.forEach((candidate, index) => {
    assets[`candidate_${index}`] = candidate.assetHash;
    blobs[`candidate_${index}`] = candidate.blobHash;
  });
  h.fake.realtime.emit({ t: "job.completed", jobId, outputs: { assets, blobs } });
}

describe("the fill gap flow", () => {
  it("renders both sides of the gap and submits generate.inpaint", async () => {
    const h = await harness();
    const started = await h.flow.start({
      region: { ...GAP, tracks: ["trk_drums", "trk_bass"] },
    });
    expect(started).toBe(true);

    // Two context renders, both on bar lines: before ends at the gap, after starts at its end.
    expect(h.renderContext).toHaveBeenCalledTimes(2);
    const [before, after] = h.renderContext.mock.calls.map(
      (call) => call[0] as { startTick: number; endTick: number },
    );
    if (before === undefined || after === undefined) throw new Error("missing contexts");
    expect(before.endTick).toBe(GAP.startTick);
    expect(after.startTick).toBe(GAP.endTick);
    expect(before.startTick % TICKS_PER_BAR).toBe(0);
    expect(after.endTick % TICKS_PER_BAR).toBe(0);
    expect(after.endTick - after.startTick).toBeLessThanOrEqual(15 * 48_000 + TICKS_PER_BAR);

    const submit = h.fake.submits[0];
    expect(submit?.body.capability).toBe("generate.inpaint");
    expect(submit?.body.priority).toBe("interactive");
    expect(Object.keys(submit?.body.assets ?? {}).sort()).toEqual(["after", "before"]);
    expect(submit?.body.params).toMatchObject({
      gapBars: 2,
      overlapBars: 2,
      tier: "preview",
      n: 3,
    });
    if (submit === undefined) throw new Error("no submit");
    expect((submit.body.params as { context: { bpm: number } }).context.bpm).toBe(120);

    // The bar is open before the first idea exists.
    expect(h.audition.store.getState().group?.id).toBe(submit?.jobId);
    expect(h.announced).toContain("Generating 3 ideas…");
  });

  it("places a candidate into the gap and accepts it with analysis and HQ", async () => {
    const h = await harness();
    await h.flow.start({ region: { ...GAP, tracks: ["trk_drums", "trk_bass"] } });
    const jobId = h.fake.submits[0]?.jobId ?? "";
    h.fake.progress(jobId, 0.4);
    expect(h.audition.store.getState().group?.queue).toEqual({ kind: "generating", pct: 0.4 });

    const candidate = await h.candidate(0);
    h.fake.partial(jobId, 0, candidate.assetHash, candidate.blobHash);
    await vi.waitFor(() => {
      expect(h.audition.store.getState().group?.candidates).toHaveLength(1);
    });

    const commits = [...h.song.history.store.getState().commits.values()].filter(
      (commit) => commit.state === "candidate",
    );
    expect(commits).toHaveLength(1);
    const snapshot = await h.song.history.readSnapshot(commits[0]?.id ?? "");
    const source = snapshot?.sources.find(
      (entry) => entry.kind === "generated" && entry.placement !== undefined,
    );
    expect(source?.placement?.sectionId).toBe(snapshot?.arrangement.sections[1]?.id);
    // The placement range is relative to the anchored section (docs/wp/2.8.md, B).
    expect(source?.placement?.range).toEqual({ startTick: 0, endTick: 2 * TICKS_PER_BAR });
    const section = snapshot?.arrangement.sections[1];
    const generated = snapshot?.tracks.find((track) => track.role === "generated");
    const clip =
      section === undefined || generated === undefined
        ? undefined
        : section.lanes[generated.id]?.clips[0];
    expect(clip?.asset).toBe(candidate.assetHash);
    // The gate's start offset is the left overlap the clip skips.
    expect(clip?.srcStart).toBe(BAR_SAMPLES);
    // The song is untouched until Accept.
    expect(
      h.song.songStore.store.getState().doc?.arrangement.sections[1]?.lanes[generated?.id ?? ""]
        ?.clips ?? [],
    ).toHaveLength(0);

    await h.audition.accept();
    await vi.waitFor(() => {
      expect(h.fake.analysed).toEqual([{ hash: candidate.assetHash, profile: "standard" }]);
      expect(h.fake.submits).toHaveLength(2);
    });
    const hq = h.fake.submits[1]?.body;
    expect(hq?.capability).toBe("generate.inpaint");
    expect(hq?.priority).toBe("background");
    expect(hq?.params).toMatchObject({ tier: "hq", n: 1, gapBars: 2 });
    expect(h.fake.realtime.topics()).toContain(`asset:${candidate.assetHash}`);
    expect(h.fake.realtime.topics()).toContain("job:job_GEN02");
    expect(h.flow.store.getState().phase).toBe("accepted");
  });

  it("cancels the job when the ideas are discarded", async () => {
    const h = await harness();
    await h.flow.start({ region: { ...GAP, tracks: ["trk_drums"] } });
    const jobId = h.fake.submits[0]?.jobId ?? "";
    await h.audition.discard();
    expect(h.fake.cancelled).toEqual([jobId]);
    expect(h.flow.store.getState().phase).toBe("cancelled");
    expect(h.audition.store.getState().group).toBeNull();
    expect(h.song.history.store.getState().commits.size).toBe(1);
  });

  it("adds every candidate a completed-only job publishes (a result-cache hit)", async () => {
    const h = await harness();
    await h.flow.start({ region: { ...GAP, tracks: ["trk_drums"] } });
    const jobId = h.fake.submits[0]?.jobId ?? "";
    const first = await h.candidate(0);
    const second = await h.candidate(1);
    const third = await h.candidate(2);
    // A cache hit sends no partials: all three arrive with `completed` (05 §4.3).
    emitCompleted(h, jobId, [first, second, third]);
    await vi.waitFor(() => {
      expect(h.audition.store.getState().group?.candidates).toHaveLength(3);
    });
    expect(candidateCommits(h)).toHaveLength(3);
    await vi.waitFor(() => {
      expect(h.flow.store.getState().phase).toBe("preview");
    });
  });

  it("does not add a streamed candidate twice when completed repeats it", async () => {
    const h = await harness();
    await h.flow.start({ region: { ...GAP, tracks: ["trk_drums"] } });
    const jobId = h.fake.submits[0]?.jobId ?? "";
    const first = await h.candidate(0);
    const second = await h.candidate(1);
    const third = await h.candidate(2);
    h.fake.partial(jobId, 0, first.assetHash, first.blobHash);
    await vi.waitFor(() => {
      expect(h.audition.store.getState().group?.candidates).toHaveLength(1);
    });

    // The normal streaming path: `completed` lists the same three candidates.
    emitCompleted(h, jobId, [first, second, third]);
    await vi.waitFor(() => {
      expect(h.audition.store.getState().group?.candidates).toHaveLength(3);
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(h.audition.store.getState().group?.candidates).toHaveLength(3);
    expect(candidateCommits(h)).toHaveLength(3);
  });
});
