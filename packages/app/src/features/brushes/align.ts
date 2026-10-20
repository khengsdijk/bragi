/**
 * Stable fx ids within one paint stroke (WP-2.4, 03 §6).
 *
 * Every `brushBatch` call creates fresh `fx_…` ids for the effects it inserts. A stroke previews
 * many times a second, and a new id means the engine has to drop the old instance (with its tail)
 * and add a new one — an audible click on a reverb while the song plays. {@link alignFxIds}
 * renames a batch's new instances to the ones the previous preview created, so the engine keeps
 * them; a committed stroke therefore reuses the instance the preview played.
 */
import type { Op, OpBatch } from "@bragi/schemas";

/** Where an `fx.add` lands plus what it is: two adds with the same key are the same instance. */
function fxKey(op: Extract<Op, { op: "fx.add" }>): string {
  const scope =
    op.scope.kind === "track"
      ? `track:${op.scope.trackId}`
      : op.scope.kind === "clip"
        ? `clip:${op.scope.clipId}`
        : "master";
  return `${scope}|${op.fx.type}|${op.fx.macroOwned ?? ""}`;
}

/** `fx:<id>/<param>` with the id replaced; any other automation target is returned unchanged. */
function renameTarget(target: string, ids: ReadonlyMap<string, string>): string {
  const match = /^fx:([^/]+)\/(.+)$/.exec(target);
  if (match === null) return target;
  const [, id = "", param = ""] = match;
  const next = ids.get(id);
  return next === undefined ? target : `fx:${next}/${param}`;
}

/** One op with every fx id in `ids` renamed. */
function renameOp(op: Op, ids: ReadonlyMap<string, string>): Op {
  switch (op.op) {
    case "fx.add": {
      const id = ids.get(op.fx.id);
      return id === undefined ? op : { ...op, fx: { ...op.fx, id } };
    }
    case "fx.update":
    case "fx.remove":
    case "fx.reorder": {
      const id = ids.get(op.fxId);
      return id === undefined ? op : { ...op, fxId: id };
    }
    case "automation.set":
    case "automation.clear": {
      const target = renameTarget(op.target, ids);
      return target === op.target ? op : { ...op, target };
    }
    default:
      return op;
  }
}

/**
 * `next` with each new `fx.add` taking the id of the matching `fx.add` in `previous`.
 *
 * The key is the scope plus the fx type and its macro owner, so a Space reverb stays the same
 * reverb across previews. Ids with no match, and batches without a previous one, stay as they
 * are: aligning an already aligned batch changes nothing.
 */
export function alignFxIds(next: OpBatch, previous: OpBatch | null): OpBatch {
  if (previous === null) return next;
  const available = new Map<string, string[]>();
  for (const op of previous.ops) {
    if (op.op !== "fx.add") continue;
    const key = fxKey(op);
    const ids = available.get(key) ?? [];
    ids.push(op.fx.id);
    available.set(key, ids);
  }
  if (available.size === 0) return next;

  const renames = new Map<string, string>();
  for (const op of next.ops) {
    if (op.op !== "fx.add") continue;
    const previousId = available.get(fxKey(op))?.shift();
    if (previousId !== undefined && previousId !== op.fx.id) {
      renames.set(op.fx.id, previousId);
    }
  }
  if (renames.size === 0) return next;
  return { ...next, ops: next.ops.map((op) => renameOp(op, renames)) as [Op, ...Op[]] };
}
