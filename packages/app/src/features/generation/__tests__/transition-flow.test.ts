/**
 * The Smooth with AI flow end to end (09 §4.4; 07 §4.1).
 *
 * The scenario a section move leaves behind: a new boundary. The test renders up to 8 bars on each
 * side, submits `generate.transition` with the requested length, places the candidate through
 * `transitionPlacement` (the section's `transitionIn` becomes `generated`), and accepts it with
 * analysis and an HQ re-render.
 */

import type { GenerateFillResult } from "@bragi/schemas";
import { describe, expect, it, vi } from "vitest";
import { type Audition, createAudition } from "../../audition/state/audition.js";

import { createSmoothFlow, type SmoothFlow } from "../state/smooth-flow.js";
import {
  BAR_SAMPLES,
  CONTEXT_BYTES,
  createFakeApi,
  flowDeps,
  openSong,
  type SongFixture,
  TICKS_PER_BAR,
} from "./generation-fixture.js";

const BOUNDARY = 6 * TICKS_PER_BAR;

interface Harness {
  readonly song: SongFixture;
  readonly fake: ReturnType<typeof createFakeApi>;
  readonly flow: SmoothFlow;
  readonly audition: Audition;
  readonly announced: string[];
  readonly renderContext: ReturnType<typeof vi.fn>;
  candidate(index: number): Promise<{ assetHash: string; blobHash: string }>;
}

async function harness(): Promise<Harness> {
  const song = await openSong();
  const fake = createFakeApi();
  const announced: string[] = [];
  let audition: Audition | null = null;
  const renderContext = vi.fn(async () => CONTEXT_BYTES);
  const flow = createSmoothFlow(
    flowDeps(song, fake, {
      renderContext: renderContext as never,
      audition: {
        open: (options) => audition?.openCandidates(options) ?? Promise.resolve(false),
        setQueue: (status) => audition?.setQueue(status),
        isOpen: () => audition?.store.getState().group != null,
      },
      onAnnounce: (message) => announced.push(message),
      onError: (message) => announced.push(message),
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
    const assetHash = await fake.put(`transition-candidate-${index}`);
    const result: GenerateFillResult = {
      schemaVersion: 1,
      index,
      asset: assetHash,
      seed: 200 + index,
      model: "fake",
      modelVersion: "1.0.0",
      passed: true,
      qualityWarning: false,
      seamScore: 0.1,
      endSeamScore: 0.2,
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
    renderContext,
    candidate,
  };
}

describe("the smooth with AI flow", () => {
  it("renders 8 bars each side of the boundary and submits generate.transition", async () => {
    const h = await harness();
    const sectionId = h.song.songStore.store.getState().doc?.arrangement.sections[2]?.id ?? "";
    const started = await h.flow.start({ sectionId, lengthBars: 1 });
    expect(started).toBe(true);

    expect(h.renderContext).toHaveBeenCalledTimes(2);
    const [before, after] = h.renderContext.mock.calls.map(
      (call) => call[0] as { startTick: number; endTick: number },
    );
    expect(before?.endTick).toBe(BOUNDARY);
    expect(after?.startTick).toBe(BOUNDARY);
    // Up to 8 bars, and clamped to the song.
    expect(BOUNDARY - (before?.startTick ?? 0)).toBeLessThanOrEqual(8 * TICKS_PER_BAR);
    expect((after?.endTick ?? 0) - BOUNDARY).toBeLessThanOrEqual(8 * TICKS_PER_BAR);
    expect(before?.startTick).toBeGreaterThanOrEqual(0);

    const submit = h.fake.submits[0];
    expect(submit?.body.capability).toBe("generate.transition");
    expect(Object.keys(submit?.body.assets ?? {}).sort()).toEqual(["after", "before"]);
    expect(submit?.body.params).toMatchObject({ lengthBars: 1, tier: "preview", n: 3 });
    expect(h.announced).toContain("Generating 3 ideas…");
  });

  it("sets the section's generated transition and accepts with analysis and HQ", async () => {
    const h = await harness();
    const sectionId = h.song.songStore.store.getState().doc?.arrangement.sections[2]?.id ?? "";
    await h.flow.start({ sectionId, lengthBars: 2 });
    const jobId = h.fake.submits[0]?.jobId ?? "";
    const candidate = await h.candidate(0);
    h.fake.partial(jobId, 0, candidate.assetHash, candidate.blobHash);
    await vi.waitFor(() => {
      expect(h.audition.store.getState().group?.candidates).toHaveLength(1);
    });

    const commits = [...h.song.history.store.getState().commits.values()].filter(
      (commit) => commit.state === "candidate",
    );
    const snapshot = await h.song.history.readSnapshot(commits[0]?.id ?? "");
    const section = snapshot?.arrangement.sections[2];
    expect(section?.transitionIn.kind).toBe("generated");
    expect(section?.transitionIn.asset).toBe(candidate.assetHash);
    expect(section?.transitionIn.lengthTicks).toBe(2 * TICKS_PER_BAR);
    // A transition has no lane clip: the engine plays it from `transitionIn` (09 §4.4).
    const generated = snapshot?.tracks.find((track) => track.role === "generated");
    expect(generated).toBeUndefined();
    expect(snapshot?.sources.at(-1)?.placement?.range).toBeUndefined();

    await h.audition.accept();
    await vi.waitFor(() => {
      expect(h.fake.analysed).toHaveLength(1);
      expect(h.fake.submits).toHaveLength(2);
    });
    expect(h.fake.submits[1]?.body).toMatchObject({
      capability: "generate.transition",
      priority: "background",
    });
    expect(h.fake.submits[1]?.body.params).toMatchObject({ tier: "hq", n: 1, lengthBars: 2 });
    expect(h.flow.store.getState().phase).toBe("accepted");
  });

  it("rejects the first section, which has no boundary before it", async () => {
    const h = await harness();
    const first = h.song.songStore.store.getState().doc?.arrangement.sections[0]?.id ?? "";
    const started = await h.flow.start({ sectionId: first, lengthBars: 1 });
    expect(started).toBe(false);
    expect(h.flow.store.getState().phase).toBe("failed");
  });
});
