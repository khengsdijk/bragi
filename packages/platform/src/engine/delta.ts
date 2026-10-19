/**
 * Applying an `EngineDelta` to a host's own copy of the document (specs/03-audio-engine.md §3.3).
 *
 * The browser worklet has no `bragi-model`, so it cannot patch a plan from a delta by itself. The
 * host keeps the last document it loaded and, for a *mix-only* change (a track's gain, pan, mute,
 * solo or name), folds the delta's whole updated tracks into that copy and asks the engine to
 * recompile the plan. Anything structural (`requiresFullResync`, added or removed tracks and
 * sections, a timebase change) is not representable that way and returns `null`: the caller
 * follows up with `loadDocument` carrying the real new document.
 */
import type { EngineDelta, ProjectJson } from "./types.js";

interface TrackLike {
  readonly id: string;
}

function isTrackList(value: unknown): value is readonly TrackLike[] {
  return Array.isArray(value) && value.every((item) => typeof item === "object" && item !== null);
}

/** The document with the delta's updated tracks swapped in, or `null` when it is not mix-only. */
export function applyMixDelta(doc: ProjectJson, delta: EngineDelta): ProjectJson | null {
  if (delta.requiresFullResync === true) return null;
  const structural = [
    "sourcesAdded",
    "sourcesRemoved",
    "tracksAdded",
    "tracksRemoved",
    "sectionsAdded",
    "sectionsRemoved",
    "sectionsUpdated",
  ] as const;
  for (const key of structural) {
    const value = delta[key];
    if (Array.isArray(value) && value.length > 0) return null;
  }
  if (delta.timebaseChanged === true || delta.masterChanged === true) return null;

  const updated = delta.tracksUpdated;
  if (!isTrackList(updated) || updated.length === 0) return doc;
  const tracks = doc.tracks;
  if (!isTrackList(tracks)) return null;
  const byId = new Map(updated.map((track) => [track.id, track]));
  return { ...doc, tracks: tracks.map((track) => byId.get(track.id) ?? track) };
}
