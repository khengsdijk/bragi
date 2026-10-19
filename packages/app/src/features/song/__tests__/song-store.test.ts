import type { OpBatch } from "@bragi/schemas";
import { describe, expect, it } from "vitest";

import { trackToggleBatch } from "../state/ops.js";
import { loadDemo } from "./fixtures.js";

describe("Song Store", () => {
  it("loads a document through bragi-model and exposes it", async () => {
    const { store, project } = await loadDemo();
    const state = store.store.getState();
    expect(state.doc?.id).toBe(project.id);
    expect(state.doc?.tracks.map((track) => track.name)).toEqual([
      "Drums",
      "Bass",
      "Pads",
      "Arpeggio",
    ]);
    expect(state.revision).toBe(1);
    expect(store.handle()).not.toBeNull();
  });

  it("commits a mute as one op batch with an engine delta", async () => {
    const { store } = await loadDemo();
    const doc = store.store.getState().doc;
    if (!doc) throw new Error("no document");
    const batch = trackToggleBatch(doc, "trk_bass", "mute", true);
    expect(batch).not.toBeNull();
    if (!batch) return;
    expect(batch.ops).toHaveLength(1);
    expect(batch.ops[0]).toEqual({
      op: "track.update",
      trackId: "trk_bass",
      patch: { mute: true },
    });
    expect(batch.label).toBe("Mute Bass");

    const outcome = store.apply(batch);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.doc.tracks.find((track) => track.id === "trk_bass")?.mute).toBe(true);
    expect(outcome.doc.tracks.find((track) => track.id === "trk_drums")?.mute).toBe(false);
    const delta = outcome.commit.delta as {
      tracksUpdated: { id: string }[];
      requiresFullResync: boolean;
    };
    expect(delta.tracksUpdated.map((track) => track.id)).toEqual(["trk_bass"]);
    expect(delta.requiresFullResync).toBe(false);
    const state = store.store.getState();
    expect(state.revision).toBe(2);
    expect(state.lastCommit?.batch.id).toBe(batch.id);
  });

  it("restores the exact document when the toggle is undone", async () => {
    const { store } = await loadDemo();
    const original = structuredClone(store.store.getState().doc);
    const doc = store.store.getState().doc;
    if (!doc) throw new Error("no document");
    const on = trackToggleBatch(doc, "trk_drums", "solo", true);
    const off = trackToggleBatch(doc, "trk_drums", "solo", false);
    if (!on || !off) throw new Error("no batches");
    expect(store.apply(on).ok).toBe(true);
    expect(store.store.getState().doc).not.toEqual(original);
    expect(store.apply(off).ok).toBe(true);
    expect(store.store.getState().doc).toEqual(original);
  });

  it("rejects an invalid batch and leaves the document untouched", async () => {
    const { store } = await loadDemo();
    const before = structuredClone(store.store.getState().doc);
    const revision = store.store.getState().revision;
    const bad = {
      id: "bat_bad",
      author: { kind: "user" },
      label: "Mute a ghost",
      ops: [{ op: "track.update", trackId: "trk_ghost", patch: { mute: true } }],
      createdAt: "2026-10-19T09:00:00Z",
    } as OpBatch;
    const outcome = store.apply(bad);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.errors[0]?.opIndex).toBe(0);
    expect(outcome.errors[0]?.code).toBeTruthy();
    expect(store.store.getState().doc).toEqual(before);
    expect(store.store.getState().revision).toBe(revision);
  });

  it("does not leak model handles across commits", async () => {
    const { store, model } = await loadDemo();
    const doc = store.store.getState().doc;
    if (!doc) throw new Error("no document");
    const baseline = model.docCount();
    for (let index = 0; index < 20; index += 1) {
      const batch = trackToggleBatch(doc, "trk_pads", "mute", index % 2 === 0);
      if (batch) store.apply(batch);
    }
    expect(model.docCount()).toBe(baseline);
    store.dispose();
    expect(model.docCount()).toBe(baseline - 1);
  });
});
