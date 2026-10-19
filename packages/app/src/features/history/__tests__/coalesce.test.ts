import type { FxInstance, Op, OpBatch } from "@bragi/schemas";
import { describe, expect, it } from "vitest";

import { coalesceBatches, coalesceOps } from "../state/coalesce.js";

const NOW = new Date("2026-10-19T12:00:00.000Z");

function step(...ops: Op[]): OpBatch {
  return {
    id: "bat_01J0000000000000000000STEP",
    author: { kind: "user" },
    label: "step",
    ops: ops as [Op, ...Op[]],
    createdAt: NOW.toISOString(),
  };
}

const REVERB: FxInstance = {
  id: "fx_01J000000000000000000REVRB",
  type: "reverb",
  params: { mix: 0, decaySec: 1.5 },
  bypass: false,
  macroOwned: "space",
};

describe("coalesceOps", () => {
  it("folds later patches into the fx.add that created the instance", () => {
    const ops = coalesceOps([
      step({ op: "fx.add", scope: { kind: "track", trackId: "trk_drums" }, fx: REVERB }),
      step({ op: "fx.update", fxId: REVERB.id, paramsPatch: { mix: 0.2 } }),
      step({ op: "fx.update", fxId: REVERB.id, paramsPatch: { mix: 0.4, decaySec: 2 } }),
    ]);
    expect(ops).toEqual([
      {
        op: "fx.add",
        scope: { kind: "track", trackId: "trk_drums" },
        fx: { ...REVERB, params: { mix: 0.4, decaySec: 2 } },
      },
    ]);
  });

  it("merges fx.update patches and keeps the latest bypass", () => {
    const ops = coalesceOps([
      step({ op: "fx.update", fxId: REVERB.id, paramsPatch: { mix: 0.2 }, bypass: true }),
      step({ op: "fx.update", fxId: REVERB.id, paramsPatch: { decaySec: 3 } }),
      step({ op: "fx.update", fxId: REVERB.id, paramsPatch: {}, bypass: false }),
    ]);
    expect(ops).toEqual([
      { op: "fx.update", fxId: REVERB.id, paramsPatch: { mix: 0.2, decaySec: 3 }, bypass: false },
    ]);
  });

  it("merges track.update patches per track and keeps different tracks apart", () => {
    const ops = coalesceOps([
      step({ op: "track.update", trackId: "trk_bass", patch: { gainDb: -1 } }),
      step({ op: "track.update", trackId: "trk_pads", patch: { pan: 0.2 } }),
      step({ op: "track.update", trackId: "trk_bass", patch: { gainDb: -3, mute: true } }),
    ]);
    expect(ops).toEqual([
      { op: "track.update", trackId: "trk_bass", patch: { gainDb: -3, mute: true } },
      { op: "track.update", trackId: "trk_pads", patch: { pan: 0.2 } },
    ]);
  });

  it("does not merge across an op that touches the same target or any target", () => {
    const removed = coalesceOps([
      step({ op: "fx.update", fxId: REVERB.id, paramsPatch: { mix: 0.2 } }),
      step({ op: "fx.reorder", fxId: REVERB.id, newIndex: 0 }),
      step({ op: "fx.update", fxId: REVERB.id, paramsPatch: { mix: 0.4 } }),
    ]);
    expect(removed).toHaveLength(3);

    const structural = coalesceOps([
      step({ op: "track.update", trackId: "trk_bass", patch: { gainDb: -1 } }),
      step({ op: "track.remove", trackId: "trk_pads" }),
      step({ op: "track.update", trackId: "trk_bass", patch: { gainDb: -2 } }),
    ]);
    expect(structural).toHaveLength(3);
  });
});

describe("coalesceBatches", () => {
  it("labels the gesture and is null without steps", () => {
    expect(coalesceBatches([], "Space on Drums", NOW)).toBeNull();
    const batch = coalesceBatches(
      [step({ op: "track.update", trackId: "trk_bass", patch: { gainDb: -1 } })],
      "Bass volume",
      NOW,
    );
    expect(batch?.label).toBe("Bass volume");
    expect(batch?.author).toEqual({ kind: "user" });
    expect(batch?.createdAt).toBe(NOW.toISOString());
    expect(batch?.id).toMatch(/^bat_/);
  });
});
