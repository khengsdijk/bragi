/**
 * Op batch builders for the canvas gestures (02 §4). The canvas never edits anything: it reports a
 * gesture, and these functions turn it into the typed batch the Song Store applies.
 */
import type { OpBatch, Project } from "@bragi/schemas";
import { t } from "../../../i18n/index.js";
import { ulid } from "../../../lib/ulid.js";

/** `bat_` + a fresh ULID (02 §2.1). */
export function newBatchId(): `bat_${string}` {
  return `bat_${ulid()}`;
}

/**
 * The batch for pressing mute or solo on a ribbon: one `track.update` (07 §4.5), authored by the
 * user, labelled in plain language for the history panel.
 */
export function trackToggleBatch(
  doc: Project,
  trackId: string,
  field: "mute" | "solo",
  value: boolean,
  now: Date = new Date(),
): OpBatch | null {
  const track = doc.tracks.find((candidate) => candidate.id === trackId);
  if (!track) return null;
  const key =
    field === "mute"
      ? value
        ? "song.track.mute"
        : "song.track.unmute"
      : value
        ? "song.track.solo"
        : "song.track.unsolo";
  return {
    id: newBatchId(),
    author: { kind: "user" },
    label: t(key, { name: track.name }),
    ops: [{ op: "track.update", trackId: track.id, patch: { [field]: value } }],
    createdAt: now.toISOString(),
  } as OpBatch;
}
