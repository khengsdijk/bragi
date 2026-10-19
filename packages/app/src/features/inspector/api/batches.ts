/**
 * Op batches for the Inspector (02 §4). Every edit is one typed batch; a drag folds its steps
 * through {@link startGesture}, so the document changes once, on release.
 *
 * Effects are addressed by id, so these builders need no document; `bragi-model` rejects an id
 * that is no longer in a chain (a remove that raced an undo), which the announcement surfaces.
 */
import type {
  FxInstance,
  FxScope,
  FxType,
  OpBatch,
  Project,
  TrackId,
  TrackPatch,
} from "@bragi/schemas";

import { t } from "../../../i18n/index.js";
import { ulid } from "../../../lib/ulid.js";
import { newBatchId } from "../../song/state/ops.js";
import { effectName, paramName } from "../labels.js";

/** `track.update` for volume or pan, one field so the change stays one edit. */
export function trackValueBatch(
  doc: Project,
  trackId: string,
  field: "gainDb" | "pan",
  value: number,
  now: Date = new Date(),
): OpBatch | null {
  const track = doc.tracks.find((candidate) => candidate.id === trackId);
  if (track === undefined) return null;
  const patch: TrackPatch = field === "gainDb" ? { gainDb: value } : { pan: value };
  return {
    id: newBatchId(),
    author: { kind: "user" },
    label:
      field === "gainDb"
        ? t("inspector.batch.volume", { name: track.name })
        : t("inspector.batch.pan", { name: track.name }),
    ops: [{ op: "track.update", trackId: track.id, patch }],
    createdAt: now.toISOString(),
  };
}

/** `fx.update` for one numeric parameter. */
export function fxParamBatch(
  fx: FxInstance,
  name: string,
  value: number,
  now: Date = new Date(),
): OpBatch {
  return {
    id: newBatchId(),
    author: { kind: "user" },
    label: t("inspector.batch.param", { param: paramName(name), name: effectName(fx.type) }),
    ops: [{ op: "fx.update", fxId: fx.id, paramsPatch: { [name]: value } }],
    createdAt: now.toISOString(),
  };
}

/** `fx.update` for bypass. */
export function fxBypassBatch(fx: FxInstance, bypass: boolean, now: Date = new Date()): OpBatch {
  return {
    id: newBatchId(),
    author: { kind: "user" },
    label: t(bypass ? "inspector.batch.bypass" : "inspector.batch.enable", {
      name: effectName(fx.type),
    }),
    ops: [{ op: "fx.update", fxId: fx.id, paramsPatch: {}, bypass }],
    createdAt: now.toISOString(),
  };
}

/** `fx.update` for a sidechain key; `null` clears it (02 §3.7, §4.3). */
export function fxSidechainBatch(
  fx: FxInstance,
  source: TrackId | null,
  now: Date = new Date(),
): OpBatch {
  return {
    id: newBatchId(),
    author: { kind: "user" },
    label: t("inspector.batch.sidechain", { name: effectName(fx.type) }),
    ops: [{ op: "fx.update", fxId: fx.id, paramsPatch: {}, sidechainSource: source }],
    createdAt: now.toISOString(),
  };
}

/** `fx.remove` from whichever chain holds the effect. */
export function fxRemoveBatch(fx: FxInstance, now: Date = new Date()): OpBatch {
  return {
    id: newBatchId(),
    author: { kind: "user" },
    label: t("inspector.batch.remove", { name: effectName(fx.type) }),
    ops: [{ op: "fx.remove", fxId: fx.id }],
    createdAt: now.toISOString(),
  };
}

/** `fx.reorder` within the effect's chain. */
export function fxMoveBatch(fx: FxInstance, newIndex: number, now: Date = new Date()): OpBatch {
  return {
    id: newBatchId(),
    author: { kind: "user" },
    label: t("inspector.batch.move", { name: effectName(fx.type) }),
    ops: [{ op: "fx.reorder", fxId: fx.id, newIndex }],
    createdAt: now.toISOString(),
  };
}

/** `fx.add` with the catalogue defaults (03 §6). */
export function fxAddBatch(
  scope: FxScope,
  type: FxType,
  defaults: Readonly<Record<string, number>>,
  now: Date = new Date(),
): OpBatch {
  return {
    id: newBatchId(),
    author: { kind: "user" },
    label: t("inspector.batch.add", { name: effectName(type) }),
    ops: [
      {
        op: "fx.add",
        scope,
        fx: {
          id: `fx_${ulid()}`,
          type,
          params: { ...defaults },
          bypass: false,
        },
      },
    ],
    createdAt: now.toISOString(),
  };
}
