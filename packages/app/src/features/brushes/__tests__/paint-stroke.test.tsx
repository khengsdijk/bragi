// @vitest-environment jsdom
/**
 * The paint controller (07 §4.4, 10 check 3): a stroke becomes one region and one history commit,
 * Escape drops the preview, and previewing never stacks brush batches. The real model and history
 * store run underneath, so the committed document is the shipped op application.
 */

import type { OpBatch } from "@bragi/schemas";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ticksAtSeconds } from "../../song/api/section-time.js";
import { createEngineController } from "../../song/state/engine-controller.js";
import type { Commit } from "../../song/state/song-store.js";
import { brushBatch } from "../batches.js";
import { usePaintStroke } from "../hooks/use-paint-stroke.js";
import { createBrushStore } from "../state/brush-store.js";
import { strokeRegion } from "../stroke.js";
import { type BrushFixture, documentOf, NOW, openBrushFixture } from "./fixtures.js";

function harness(fixture: BrushFixture, clock: () => number = () => Date.now()) {
  const brushes = createBrushStore({ brush: "space", sizeStrength: 0.5 });
  const announce = vi.fn<(message: string) => void>();
  const controller = createEngineController({
    document: () => fixture.store.store.getState().doc,
    durationSec: () => 32,
  });
  const hook = renderHook(() =>
    usePaintStroke({
      songStore: fixture.store,
      controller,
      model: fixture.model,
      brushes,
      history: fixture.history,
      onAnnounce: announce,
      now: clock,
    }),
  );
  return { brushes, announce, controller, result: hook.result, unmount: hook.unmount };
}

function point(sec: number, pressure = 0.5, trackId = "trk_drums") {
  return { sec, trackId, pressure };
}

function event(points: ReturnType<typeof point>[], wheelDelta = 0) {
  return { points, wheelDelta, pointerType: "mouse" as const };
}

function lastBatch(fixture: BrushFixture) {
  return [...fixture.history.store.getState().commits.values()].at(-1)?.batch;
}

/** Every fx instance the batch inserts, in order. */
function addedFxIds(batch: OpBatch | null | undefined): string[] {
  return (batch?.ops ?? []).flatMap((op) => (op.op === "fx.add" ? [op.fx.id] : []));
}

describe("paint stroke controller", () => {
  it("commits one labelled batch per stroke", async () => {
    const fixture = await openBrushFixture();
    await fixture.history.load();
    const startHead = fixture.history.store.getState().head;
    const { result, announce } = harness(fixture);

    act(() => {
      result.current.onPaintStart(event([point(5)]));
      result.current.onPaintMove(event([point(5), point(6)]));
      result.current.onPaintEnd(event([point(5), point(6), point(7)]));
    });
    await waitFor(() => expect(fixture.history.store.getState().head).not.toBe(startHead));

    expect(fixture.history.store.getState().commits.size).toBe(2);
    const batch = lastBatch(fixture);
    expect(batch?.label).toBe("Space on Drums, bars 3–4");
    expect(batch?.ops.length).toBeGreaterThan(0);
    expect(announce).toHaveBeenCalledWith("Space on Drums, bars 3–4");
  });

  it("cancels with Escape: no commit and the document is unchanged", async () => {
    const fixture = await openBrushFixture();
    await fixture.history.load();
    const before = structuredClone(documentOf(fixture));
    const head = fixture.history.store.getState().head;
    const { result } = harness(fixture);

    act(() => {
      result.current.onPaintStart(event([point(5)]));
      result.current.onPaintMove(event([point(5), point(6)]));
    });
    expect(fixture.store.store.getState().preview).not.toBeNull();
    act(() => {
      result.current.onPaintCancel({});
    });
    expect(fixture.store.store.getState().preview).toBeNull();
    expect(fixture.history.store.getState().head).toBe(head);
    expect(documentOf(fixture)).toEqual(before);
  });

  it("never stacks previews: two moves then release equals one brushBatch on the old doc", async () => {
    let clock = 0;
    const fixture = await openBrushFixture();
    const expected = await openBrushFixture();
    await fixture.history.load();
    const before = documentOf(fixture);
    const handle = fixture.store.handle();
    if (handle === null) throw new Error("no handle");

    const { result, brushes } = harness(fixture, () => clock);
    brushes.setBrush("louder");
    act(() => {
      result.current.onPaintStart(event([point(5)]));
      clock = 200;
      result.current.onPaintMove(event([point(5), point(6)]));
      clock = 400;
      result.current.onPaintMove(event([point(5), point(6), point(7)]));
      clock = 600;
      result.current.onPaintEnd(event([point(5), point(6), point(7)]));
    });
    await waitFor(() => expect(fixture.history.store.getState().commits.size).toBe(2));

    const region = strokeRegion({
      points: [5, 6, 7].map((sec) => ({
        tick: ticksAtSeconds(fixture.model, handle, sec),
        trackId: "trk_drums",
        pressure: 0.5,
      })),
      sizeStrength: 0.5,
      pointerType: "mouse",
    });
    expect(region).not.toBeNull();
    if (region === null) return;
    const single = brushBatch(before, "louder", { region, strength: 0.5 }, expected.model, NOW);
    expect(single).not.toBeNull();
    if (single === null) return;
    const applied = expected.store.apply(single);
    expect(applied.ok).toBe(true);
    // The committed document is one brush batch on the pre-stroke doc, not two stacked previews.
    expect(documentOf(fixture)).toEqual(documentOf(expected));
    expect(lastBatch(fixture)?.ops).toHaveLength(single.ops.length);
  });

  it("follows a pen resting in place: the same point updates its pressure", async () => {
    const fixture = await openBrushFixture();
    await fixture.history.load();
    const { result, brushes } = harness(fixture);
    brushes.setBrush("louder");
    const pen = (pressure: number) => ({
      points: [{ sec: 5, trackId: "trk_drums", pressure }],
      wheelDelta: 0,
      pointerType: "pen" as const,
    });

    act(() => {
      result.current.onPaintStart(pen(0.2));
      result.current.onPaintMove(pen(0.8));
      result.current.onPaintEnd(pen(0.8));
    });
    await waitFor(() => expect(fixture.history.store.getState().commits.size).toBe(2));

    const lane = documentOf(fixture).arrangement.sections[1]?.lanes.trk_drums?.automation.find(
      (entry) => entry.target === "track:trk_drums/gainDb",
    );
    const inside = lane?.points.find((entry) => entry.value > 0);
    expect(inside?.value).toBeCloseTo(9.6, 6);
  });

  it("takes the strength from wheel notches while painting", async () => {
    let clock = 0;
    const fixture = await openBrushFixture();
    await fixture.history.load();
    const { result, brushes } = harness(fixture, () => clock);
    brushes.setBrush("louder");

    act(() => {
      result.current.onPaintStart(event([point(5)]));
      clock = 200;
      result.current.onPaintMove(event([point(5), point(6)], 3));
      clock = 400;
      result.current.onPaintEnd(event([point(5), point(6)], 3));
    });
    await waitFor(() => expect(fixture.history.store.getState().commits.size).toBe(2));

    const section = documentOf(fixture).arrangement.sections[1];
    const lane = section?.lanes.trk_drums?.automation.find(
      (entry) => entry.target === "track:trk_drums/gainDb",
    );
    expect(lane).toBeDefined();
    // 0.5 from the size slider + 3 notches × 0.1 = 0.8, and Louder adds up to 12 dB × strength.
    const inside = lane?.points.find((entry) => entry.value > 0);
    expect(inside?.value).toBeCloseTo(9.6, 6);
  });

  it("keeps one fx instance for the stroke and commits the previewed ids", async () => {
    let clock = 0;
    const fixture = await openBrushFixture();
    await fixture.history.load();
    const { result, controller, brushes } = harness(fixture, () => clock);
    const commit = vi.spyOn(controller, "commit");
    brushes.setBrush("space");

    act(() => {
      result.current.onPaintStart(event([point(5)]));
      clock = 200;
      result.current.onPaintMove(event([point(5), point(6)]));
      clock = 400;
      result.current.onPaintMove(event([point(5), point(6), point(7)]));
    });

    const painting = commit.mock.calls.map(([sent]) => sent as Commit);
    // No preview ever reverts to the document: one replace delta per move, all with a batch.
    expect(painting.length).toBeGreaterThanOrEqual(3);
    expect(painting.every((sent) => sent.batch !== null)).toBe(true);
    const firstPreview = addedFxIds(painting[0]?.batch);
    expect(firstPreview.length).toBeGreaterThan(0);
    for (const sent of painting) expect(addedFxIds(sent.batch)).toEqual(firstPreview);

    act(() => {
      clock = 600;
      result.current.onPaintEnd(event([point(5), point(6), point(7)]));
    });
    await waitFor(() => expect(fixture.history.store.getState().commits.size).toBe(2));

    // One commit, and it keeps the instances the first preview created (03 §6: a surviving id
    // keeps the reverb's tail).
    expect(lastBatch(fixture)?.label).toBe("Space on Drums, bars 3–4");
    expect(addedFxIds(lastBatch(fixture))).toEqual(firstPreview);
    const all = commit.mock.calls.map(([sent]) => sent as Commit);
    expect(all.filter((sent) => sent.batch === null)).toHaveLength(0);
  });
});
