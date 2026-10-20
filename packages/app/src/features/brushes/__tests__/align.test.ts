/**
 * `alignFxIds` (WP-2.4): a paint stroke's later previews reuse the fx instances its first preview
 * created, so the engine never removes and re-adds them while the song plays (03 §6).
 */
import type { FxScope, MacroId, Op, OpBatch } from "@bragi/schemas";
import { describe, expect, it } from "vitest";

import { alignFxIds } from "../align.js";

const NOW = "2026-10-19T12:00:00.000Z";
const TRACK: FxScope = { kind: "track", trackId: "trk_drums" };

function batch(ops: Op[], id = "bat_ALIGN0000000000000000001"): OpBatch {
  return { id, author: { kind: "user" }, label: "Test", ops: ops as [Op, ...Op[]], createdAt: NOW };
}

function fxAdd(
  id: string,
  type: "reverb" | "width" | "lofi",
  options: { scope?: FxScope; macroOwned?: MacroId } = {},
): Op {
  return {
    op: "fx.add",
    scope: options.scope ?? TRACK,
    fx: {
      id,
      type,
      params: { mix: 0.2 },
      bypass: false,
      ...(options.macroOwned === undefined ? {} : { macroOwned: options.macroOwned }),
    },
  };
}

function point(tick = 0): { tick: number; value: number; curve: "linear" } {
  return { tick, value: 0.2, curve: "linear" };
}

describe("alignFxIds", () => {
  it("renames every reference to a matched fx id", () => {
    const oldReverb = "fx_REVERBOLD0000000000000001";
    const oldWidth = "fx_WIDTHOLD0000000000000001";
    const newReverb = "fx_REVERBNEW0000000000000001";
    const newWidth = "fx_WIDTHNEW0000000000000001";
    const previous = batch([
      fxAdd(oldReverb, "reverb", { macroOwned: "space" }),
      fxAdd(oldWidth, "width", { macroOwned: "space" }),
    ]);
    const next = batch([
      fxAdd(newReverb, "reverb", { macroOwned: "space" }),
      fxAdd(newWidth, "width", { macroOwned: "space" }),
      { op: "fx.update", fxId: newReverb, paramsPatch: { mix: 0.4 } },
      { op: "fx.reorder", fxId: newReverb, newIndex: 0 },
      {
        op: "automation.set",
        scope: { kind: "lane", sectionId: "sec_TEST", trackId: "trk_drums" },
        target: `fx:${newReverb}/mix`,
        points: [point()],
      },
      {
        op: "automation.clear",
        scope: { kind: "master" },
        target: `fx:${newWidth}/width`,
      },
    ]);

    const aligned = alignFxIds(next, previous);
    expect(aligned.ops).toEqual([
      fxAdd(oldReverb, "reverb", { macroOwned: "space" }),
      fxAdd(oldWidth, "width", { macroOwned: "space" }),
      { op: "fx.update", fxId: oldReverb, paramsPatch: { mix: 0.4 } },
      { op: "fx.reorder", fxId: oldReverb, newIndex: 0 },
      {
        op: "automation.set",
        scope: { kind: "lane", sectionId: "sec_TEST", trackId: "trk_drums" },
        target: `fx:${oldReverb}/mix`,
        points: [point()],
      },
      { op: "automation.clear", scope: { kind: "master" }, target: `fx:${oldWidth}/width` },
    ]);
    // The batch itself (id, label, author) is kept; only the ops change.
    expect(aligned.id).toBe(next.id);
    expect(aligned.label).toBe(next.label);
  });

  it("leaves unmatched ids and other automation targets alone", () => {
    const previous = batch([
      fxAdd("fx_KEEPME00000000000000000001", "reverb", { macroOwned: "space" }),
    ]);
    const next = batch([
      fxAdd("fx_OTHER00000000000000000001", "lofi"),
      fxAdd("fx_SCOPED0000000000000000001", "reverb", {
        scope: { kind: "track", trackId: "trk_bass" },
        macroOwned: "space",
      }),
      {
        op: "automation.set",
        scope: { kind: "lane", sectionId: "sec_TEST", trackId: "trk_drums" },
        target: "track:trk_drums/gainDb",
        points: [point()],
      },
    ]);

    expect(alignFxIds(next, previous)).toBe(next);
  });

  it("is idempotent", () => {
    const previous = batch([fxAdd("fx_STABLE00000000000000000001", "reverb")]);
    const next = batch([
      fxAdd("fx_FRESH000000000000000000001", "reverb"),
      {
        op: "automation.set",
        scope: { kind: "master" },
        target: "fx:fx_FRESH000000000000000000001/mix",
        points: [point()],
      },
    ]);
    const once = alignFxIds(next, previous);
    expect(alignFxIds(once, previous)).toEqual(once);
  });

  it("is a no-op without a previous batch", () => {
    const next = batch([fxAdd("fx_FRESH000000000000000000001", "reverb")]);
    expect(alignFxIds(next, null)).toBe(next);
  });
});
