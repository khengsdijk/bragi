import { readdirSync, readFileSync } from "node:fs";

import { type EngineHost, type EngineState, parseMigrations } from "@bragi/platform";
import { createMemoryPlatform } from "@bragi/platform/testing";
import type { JobEvent, Op, OpBatch } from "@bragi/schemas";
import { describe, expect, it, vi } from "vitest";

import { createHistory } from "../../history/state/history.js";
import { loadTestModel } from "../../song/__tests__/fixtures.js";
import { buildDemoProject, fakeAssetHash, SHORT_DEMO } from "../../song/api/demo-song.js";
import { createEngineController } from "../../song/state/engine-controller.js";
import { createSongStore } from "../../song/state/song-store.js";
import { contextSeconds, createAudition } from "../state/audition.js";
import { type CandidateSource, statusFromJobEvent } from "../state/candidate-status.js";

const MIGRATIONS_DIR = new URL("../../../../../schemas/sqlite/migrations/", import.meta.url);
const migrations = parseMigrations(
  Object.fromEntries(
    readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .map((name) => [name, readFileSync(new URL(name, MIGRATIONS_DIR), "utf8")]),
  ),
);

const NOW = new Date("2026-10-20T12:00:00.000Z");
let batchCounter = 0;

function batch(ops: Op[], label: string): OpBatch {
  batchCounter += 1;
  return {
    id: `bat_${String(batchCounter).padStart(6, "0")}`,
    author: { kind: "ai", planId: "pln_01JAUDITIONTEST0000000000", model: "test" },
    label,
    ops: ops as [Op, ...Op[]],
    createdAt: NOW.toISOString(),
  };
}

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

/** A song with history, an engine controller on a fake host and an audition over both. */
async function open(source?: CandidateSource) {
  const platform = await createMemoryPlatform(migrations);
  const model = await loadTestModel();
  const built = buildDemoProject(SHORT_DEMO, {
    assetFor: (key) => fakeAssetHash(`audition:${key}`),
    projectId: "AUDITIONTEST00000000000001",
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
  const timers: (() => void)[] = [];
  const announcements: string[] = [];
  const outcomes: unknown[] = [];
  const audition = createAudition({
    controller,
    history,
    document: () => songStore.store.getState().doc,
    ...(source === undefined ? {} : { source }),
    onOutcome: (outcome) => {
      outcomes.push(outcome);
      if (outcome?.ok) controller.commit(outcome.commit, outcome.doc);
    },
    onAnnounce: (message) => announcements.push(message),
    setTimeout: (callback) => timers.push(callback),
  });
  const candidates = await history.addCandidates(
    [
      batch([{ op: "track.update", trackId: "trk_bass", patch: { gainDb: -6 } }], "Quieter bass"),
      batch([{ op: "track.update", trackId: "trk_drums", patch: { mute: true } }], "No drums"),
      batch([{ op: "track.update", trackId: "trk_bass", patch: { gainDb: 3 } }], "Louder bass"),
    ],
    "grp_ideas",
  );
  return {
    songStore,
    history,
    host,
    controller,
    audition,
    candidates,
    timers,
    announcements,
    outcomes,
  };
}

const event = (type: JobEvent["type"], pct?: number): JobEvent => ({
  schemaVersion: 1,
  jobId: "job_01",
  type,
  ...(pct === undefined ? {} : { pct }),
});

describe("candidate status", () => {
  it("maps job events onto the badge", () => {
    expect(statusFromJobEvent(event("started"))).toEqual({ kind: "generating", pct: 0 });
    expect(statusFromJobEvent(event("progress", 0.4))).toEqual({ kind: "generating", pct: 0.4 });
    expect(statusFromJobEvent(event("progress", 3))).toEqual({ kind: "generating", pct: 1 });
    expect(statusFromJobEvent(event("partial"))).toEqual({ kind: "preview" });
    expect(statusFromJobEvent(event("completed"))).toEqual({ kind: "hq" });
    expect(statusFromJobEvent(event("failed"))).toEqual({ kind: "failed" });
  });
});

describe("the audition store", () => {
  it("warms three candidates, plays idea 1 and loops the region with two bars of context", async () => {
    const { audition, host, controller, songStore, announcements } = await open();
    const opened = await audition.openCandidates({
      group: "grp_ideas",
      prompt: "Make the bass sit better",
      region: { startSec: 8, endSec: 16 },
    });
    expect(opened).toBe(true);
    const state = audition.store.getState();
    expect(state.group?.candidates.map((candidate) => candidate.label)).toEqual([
      "Quieter bass",
      "No drums",
      "Louder bass",
    ]);
    expect(host.warm.mock.calls.map(([slot]) => slot)).toEqual([1, 2, 3]);
    expect(state.selected).toBe(1);
    expect(host.audition).toHaveBeenLastCalledWith(1);
    const doc = songStore.store.getState().doc;
    if (doc === null) throw new Error("no document");
    const context = contextSeconds(doc);
    expect(controller.store.getState().loopRange).toEqual({
      startSec: 8 - context,
      endSec: 16 + context,
    });
    expect(announcements.at(-1)).toBe("3 version ideas ready, playing Quieter bass");
    // One group at a time (07 §6).
    expect(await audition.openCandidates({ group: "grp_ideas", prompt: "again" })).toBe(false);
  });

  it("switches slots and refuses a slot that is not warm", async () => {
    const { audition, host } = await open();
    await audition.openCandidates({ group: "grp_ideas", prompt: "p" });
    expect(audition.select(3)).toBe(true);
    expect(audition.select(0)).toBe(true);
    expect(host.audition.mock.calls.map(([slot]) => slot)).toEqual([1, 3, 0]);
  });

  it("accepts the selected candidate: HEAD moves, siblings are discarded, slots released", async () => {
    const { audition, history, candidates, songStore, host, timers, controller } = await open();
    await audition.openCandidates({ group: "grp_ideas", prompt: "p" });
    audition.select(2);
    expect(await audition.accept()).toBe(true);
    const state = history.store.getState();
    expect(state.head).toBe(candidates[1]?.id);
    expect(state.commits.get(candidates[0]?.id ?? "")?.state).toBe("discarded");
    expect(state.commits.get(candidates[2]?.id ?? "")?.state).toBe("discarded");
    const doc = songStore.store.getState().doc;
    expect(doc?.tracks.find((track) => track.id === "trk_drums")?.mute).toBe(true);
    // The engine crossfades to the new HEAD itself; no audition(0) jumps back to the old one.
    expect(host.audition).not.toHaveBeenLastCalledWith(0);
    expect(controller.store.getState().auditionSlot).toBe(0);
    expect(audition.store.getState().group).toBeNull();
    for (const timer of timers) timer();
    expect(host.release.mock.calls.map(([slot]) => slot).sort()).toEqual([1, 2, 3]);
  });

  it("discards the group and returns to the original", async () => {
    const { audition, history, candidates, host, announcements } = await open();
    const head = history.store.getState().head;
    await audition.openCandidates({ group: "grp_ideas", prompt: "p" });
    await audition.discard();
    const state = history.store.getState();
    expect(state.head).toBe(head);
    for (const candidate of candidates) {
      expect(state.commits.get(candidate.id)?.state).toBe("discarded");
    }
    expect(host.audition).toHaveBeenLastCalledWith(0);
    expect(announcements.at(-1)).toBe("Discarded the ideas, back to the original");
  });

  it("follows job events: queued candidates warm when their preview lands, HQ re-warms", async () => {
    const listeners: ((candidateId: string, event: JobEvent) => void)[] = [];
    const moreLike = vi.fn();
    const source: CandidateSource = {
      subscribe: (_group, listener) => {
        listeners.push(listener);
        return () => {};
      },
      moreLike,
    };
    const { audition, host, candidates } = await open(source);
    await audition.openCandidates({
      group: "grp_ideas",
      prompt: "p",
      initialStatus: { kind: "queued" },
    });
    expect(host.warm).not.toHaveBeenCalled();
    expect(audition.store.getState().selected).toBe(0);
    const first = candidates[0]?.id ?? "";
    listeners[0]?.(first, event("progress", 0.5));
    expect(audition.store.getState().group?.candidates[0]?.status).toEqual({
      kind: "generating",
      pct: 0.5,
    });
    listeners[0]?.(first, event("partial"));
    await vi.waitFor(() => expect(host.warm).toHaveBeenCalledTimes(1));
    expect(audition.store.getState().warm).toEqual([1]);
    listeners[0]?.(first, event("completed"));
    await vi.waitFor(() => expect(host.warm).toHaveBeenCalledTimes(2));

    expect(audition.canMoreLike()).toBe(true);
    audition.select(1);
    audition.moreLike();
    expect(moreLike).toHaveBeenCalledWith(first);
  });

  it("a group opened right after another keeps its slots and retries a refused warm", async () => {
    const { audition, history, host, timers } = await open();
    const state = history.store.getState();
    const root = [...state.commits.values()].find((commit) => commit.parent === null);
    if (root === undefined || state.head === null) throw new Error("no versions");
    await audition.openCompare(root.id, state.head);
    audition.select(2);
    await audition.discard();
    // Slot 2 is still fading out: the engine refuses the first warm of it.
    host.warm.mockImplementationOnce(async () => {});
    host.warm.mockImplementationOnce(async () => {
      throw new Error("could not warm slot 2");
    });
    const opening = audition.openCandidates({ group: "grp_ideas", prompt: "p" });
    await vi.waitFor(() => expect(timers.length).toBeGreaterThanOrEqual(2));
    // The closed comparison's release timer and the retry's wait fire.
    for (const timer of timers.splice(0)) timer();
    expect(await opening).toBe(true);
    expect(audition.store.getState().warm.slice().sort()).toEqual([1, 2, 3]);
    expect(host.release).not.toHaveBeenCalled();
  });

  it("compares two versions without committing anything", async () => {
    const { audition, history, host } = await open();
    const before = history.store.getState();
    const [root] = [...before.commits.values()].filter((commit) => commit.parent === null);
    const head = before.head;
    if (root === undefined || head === null) throw new Error("no versions");
    expect(await audition.openCompare(root.id, head)).toBe(true);
    expect(audition.store.getState().group?.kind).toBe("compare");
    expect(audition.store.getState().selected).toBe(1);
    expect(audition.canMoreLike()).toBe(false);
    expect(await audition.accept()).toBe(false);
    audition.select(2);
    await audition.discard();
    expect(host.audition).toHaveBeenLastCalledWith(0);
    expect(history.store.getState().commits.size).toBe(before.commits.size);
    expect(history.store.getState().head).toBe(head);
  });
});
