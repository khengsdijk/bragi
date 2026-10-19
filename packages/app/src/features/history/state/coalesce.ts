/**
 * Folding one gesture's batches into one commit (07 §4.5: a slider drag previews live and commits
 * once on release).
 *
 * While a gesture runs, each step is applied to the Song Store's preview copy (see `gesture.ts`);
 * on release the steps become one batch for `history.commit`. Applying that batch to the document
 * must give the preview, so ops are only ever merged into an earlier op on the same target, and
 * only when nothing in between touches that target.
 */
import type {
  FxAddOp,
  FxUpdateOp,
  Op,
  OpBatch,
  SectionMoveOp,
  TrackUpdateOp,
} from "@bragi/schemas";

import { newBatchId } from "../../song/state/ops.js";

/** The target an op writes to, for the ops that can absorb a later patch. */
function patchTarget(op: Op): string | null {
  switch (op.op) {
    case "fx.add":
      return `fx:${op.fx.id}`;
    case "fx.update":
      return `fx:${op.fxId}`;
    case "track.update":
      return `track:${op.trackId}`;
    case "section.move":
      return `section:${op.sectionId}`;
    default:
      return null;
  }
}

/** Whether `op` may join an earlier op on the same target. */
function absorbs(op: Op): boolean {
  return op.op === "fx.update" || op.op === "track.update" || op.op === "section.move";
}

/** Every target an op reads or writes; `"*"` when it can reach any of them. */
function touches(op: Op): readonly string[] {
  switch (op.op) {
    case "fx.add":
    case "fx.update":
    case "track.update":
      return [patchTarget(op) as string];
    case "fx.remove":
    case "fx.reorder":
      return [`fx:${op.fxId}`];
    default:
      return ["*"];
  }
}

/** `later` folded into `earlier`, or `null` when the two cannot merge. */
function merge(earlier: Op, later: Op): Op | null {
  if (later.op === "fx.update") {
    if (earlier.op === "fx.add") {
      const fx = {
        ...earlier.fx,
        params: { ...earlier.fx.params, ...later.paramsPatch },
        ...(later.bypass === undefined ? {} : { bypass: later.bypass }),
      };
      return { ...earlier, fx } satisfies FxAddOp;
    }
    if (earlier.op === "fx.update") {
      const bypass = later.bypass ?? earlier.bypass;
      return {
        op: "fx.update",
        fxId: earlier.fxId,
        paramsPatch: { ...earlier.paramsPatch, ...later.paramsPatch },
        ...(bypass === undefined ? {} : { bypass }),
      } satisfies FxUpdateOp;
    }
  }
  if (later.op === "section.move" && earlier.op === "section.move") {
    // `toIndex` is the final position, so the last move of a drag is the whole drag.
    return { ...earlier, toIndex: later.toIndex } satisfies SectionMoveOp;
  }
  if (later.op === "track.update" && earlier.op === "track.update") {
    return {
      op: "track.update",
      trackId: earlier.trackId,
      patch: { ...earlier.patch, ...later.patch },
    } satisfies TrackUpdateOp;
  }
  return null;
}

/** The ops of `batches` in order, with each patch folded into the earliest op it can join. */
export function coalesceOps(batches: readonly OpBatch[]): Op[] {
  const ops: Op[] = [];
  for (const op of batches.flatMap((batch) => batch.ops)) {
    const target = absorbs(op) ? patchTarget(op) : null;
    let merged = false;
    if (target !== null) {
      for (let index = ops.length - 1; index >= 0; index -= 1) {
        const candidate = ops[index] as Op;
        const reached = touches(candidate);
        if (patchTarget(candidate) === target) {
          const folded = merge(candidate, op);
          if (folded !== null) {
            ops[index] = folded;
            merged = true;
          }
          break;
        }
        if (reached.includes("*") || reached.includes(target)) break;
      }
    }
    if (!merged) ops.push(op);
  }
  return ops;
}

/**
 * One batch for a whole gesture, or `null` when it had no steps.
 *
 * The author is the first step's; `label` names the gesture in the history panel.
 */
export function coalesceBatches(
  batches: readonly OpBatch[],
  label: string,
  now: Date = new Date(),
): OpBatch | null {
  const first = batches[0];
  const ops = coalesceOps(batches);
  if (first === undefined || ops.length === 0) return null;
  return {
    id: newBatchId(),
    author: first.author,
    label,
    ops: ops as [Op, ...Op[]],
    createdAt: now.toISOString(),
  };
}
