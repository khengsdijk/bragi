/**
 * WP-2.3 task D (engine smoothness): dragging a slider leaves the document untouched until the
 * release, records exactly one history commit, and sends the engine only mix deltas — the
 * controller never reloads the plan while the fader moves.
 */
import { describe, expect, it, vi } from "vitest";

import { startGesture } from "../../history/state/gesture.js";
import { createEngineController } from "../../song/state/engine-controller.js";
import type { ApplyOutcome } from "../../song/state/song-store.js";
import { trackValueBatch } from "../api/batches.js";
import { fakeHost, liveDoc, openInspectorFixture } from "./fixture.js";

interface Delta {
  readonly requiresFullResync?: boolean;
  readonly tracksAdded?: readonly unknown[];
  readonly tracksRemoved?: readonly unknown[];
  readonly tracksUpdated?: readonly { readonly id: string }[];
}

describe("Inspector gestures and the engine", () => {
  it("previews N steps, commits once and sends only mix deltas", async () => {
    const fixture = await openInspectorFixture();
    const { host } = fakeHost();
    const controller = createEngineController({
      createEngine: async () => host,
      document: () => fixture.store.store.getState().doc,
      durationSec: () => 32,
    });
    await controller.play();
    const applyDelta = vi.mocked(host.applyDelta);
    const loadDocument = vi.mocked(host.loadDocument);
    applyDelta.mockClear();
    loadDocument.mockClear();

    const sent: ApplyOutcome[] = [];
    const gesture = startGesture({
      songStore: fixture.store,
      history: fixture.history,
      engine: (commit, doc) => {
        const outcome: ApplyOutcome = { ok: true, doc, commit };
        sent.push(outcome);
        controller.commit(commit, doc);
      },
    });
    if (gesture === null) throw new Error("expected a gesture");

    const values = [-1, -2, -3, -4, -5];
    for (const value of values) {
      const batch = trackValueBatch(liveDoc(fixture), "trk_drums", "gainDb", value);
      if (batch === null) throw new Error("expected a batch");
      expect(gesture.step(batch).ok).toBe(true);
      // 01 §5: the document never changes while a drag runs; controls read the preview.
      expect(liveDoc(fixture).tracks.find((track) => track.id === "trk_drums")?.gainDb).toBe(0);
      expect(
        fixture.store.store.getState().preview?.tracks.find((track) => track.id === "trk_drums")
          ?.gainDb,
      ).toBe(value);
    }
    expect(sent).toHaveLength(values.length);
    const before = fixture.history.store.getState().commits.size;

    const committed = await gesture.commit("Volume on Drums");
    expect(committed?.ok).toBe(true);
    expect(fixture.history.store.getState().commits.size).toBe(before + 1);
    expect(liveDoc(fixture).tracks.find((track) => track.id === "trk_drums")?.gainDb).toBe(-5);
    expect(fixture.store.store.getState().preview).toBeNull();

    // Each preview step and the release reach the engine; no step reloads the plan.
    expect(applyDelta).toHaveBeenCalledTimes(values.length + 1);
    expect(loadDocument).not.toHaveBeenCalled();
    for (const call of applyDelta.mock.calls) {
      const delta = call[0] as unknown as Delta;
      expect(delta.requiresFullResync).toBe(false);
      expect(delta.tracksAdded ?? []).toHaveLength(0);
      expect(delta.tracksRemoved ?? []).toHaveLength(0);
      expect(delta.tracksUpdated?.map((track) => track.id)).toEqual(["trk_drums"]);
    }
  });
});
