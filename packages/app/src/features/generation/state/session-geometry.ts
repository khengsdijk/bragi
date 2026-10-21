/**
 * The song geometry a generation plan needs: the model handle, bar lengths in samples and tick →
 * sample conversions (09 §4, 06 §5).
 *
 * One implementation for the shared session and the planner's execute path, so a fill's offsets
 * mean the same thing wherever the candidate is placed.
 */
import type { SongStore } from "../../song/state/song-store.js";
import type { SessionGeometry } from "./generation-session.js";
import { secondsAtTick, ticksPerBarAt } from "./musical-context.js";

/** The current document's geometry, or `null` before a song is loaded. */
export function geometryFor(songStore: SongStore): SessionGeometry | null {
  const handle = songStore.handle();
  const doc = songStore.store.getState().doc;
  if (handle === null || doc === null) return null;
  const model = songStore.model;
  return {
    model,
    handle,
    barSamplesAt: (tick) =>
      Math.max(
        1,
        Math.round(
          (secondsAtTick(model, handle, tick + ticksPerBarAt(doc, tick)) -
            secondsAtTick(model, handle, tick)) *
            48_000,
        ),
      ),
    samplesBetween: (startTick, endTick) =>
      Math.max(
        0,
        Math.round(
          (secondsAtTick(model, handle, endTick) - secondsAtTick(model, handle, startTick)) *
            48_000,
        ),
      ),
    secondsAt: (tick) => secondsAtTick(model, handle, tick),
  };
}
