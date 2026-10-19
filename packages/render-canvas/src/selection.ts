/**
 * The selection model (07 §5): one of `{sections} | {tracks} | {clips} | {region}`, serialised
 * into the URL search param `sel` so links and history preserve it.
 *
 * Wire format. IDs use the alphabet `[0-9A-Za-z_]` (02 §2.1), so none of `: , - *` can occur
 * inside one:
 *
 * | Selection | `sel=` |
 * |---|---|
 * | sections | `s:sec_01,sec_02` |
 * | tracks | `t:trk_a` |
 * | clips | `c:clp_a,clp_b` |
 * | region | `r:3840-15360:trk_a,trk_b` or `r:3840-15360:*` for all tracks |
 */
import type { Selection } from "./types.js";

export const NO_SELECTION: Selection = { kind: "none" };

const ID = /^[0-9A-Za-z_]{1,80}$/;

/** `sel` for a selection; the empty string for none (callers drop the param). */
export function encodeSelection(selection: Selection): string {
  switch (selection.kind) {
    case "none":
      return "";
    case "sections":
      return selection.ids.length === 0 ? "" : `s:${selection.ids.join(",")}`;
    case "tracks":
      return selection.ids.length === 0 ? "" : `t:${selection.ids.join(",")}`;
    case "clips":
      return selection.ids.length === 0 ? "" : `c:${selection.ids.join(",")}`;
    case "region": {
      const { region } = selection;
      const tracks = region.tracks === "all" ? "*" : region.tracks.join(",");
      return `r:${region.startTick}-${region.endTick}:${tracks}`;
    }
  }
}

function parseIds(text: string): string[] | null {
  if (text === "") return null;
  const ids = text.split(",");
  return ids.every((id) => ID.test(id)) ? ids : null;
}

/**
 * Parses a `sel` value. Anything malformed is "no selection" rather than an error: a stale or
 * hand-edited link must still open the song.
 */
export function decodeSelection(text: string | null | undefined): Selection {
  if (!text) return NO_SELECTION;
  const colon = text.indexOf(":");
  if (colon !== 1) return NO_SELECTION;
  const tag = text[0];
  const rest = text.slice(2);
  if (tag === "s" || tag === "t" || tag === "c") {
    const ids = parseIds(rest);
    if (ids === null) return NO_SELECTION;
    return { kind: tag === "s" ? "sections" : tag === "t" ? "tracks" : "clips", ids };
  }
  if (tag === "r") {
    const match = /^(\d{1,15})-(\d{1,15}):(.+)$/.exec(rest);
    if (!match) return NO_SELECTION;
    const startTick = Number(match[1]);
    const endTick = Number(match[2]);
    if (!(endTick > startTick)) return NO_SELECTION;
    const trackText = match[3] ?? "";
    if (trackText === "*") {
      return { kind: "region", region: { startTick, endTick, tracks: "all" } };
    }
    const ids = parseIds(trackText);
    if (ids === null) return NO_SELECTION;
    return { kind: "region", region: { startTick, endTick, tracks: ids } };
  }
  return NO_SELECTION;
}

/** True when two selections select the same things. */
export function sameSelection(a: Selection, b: Selection): boolean {
  return encodeSelection(a) === encodeSelection(b);
}

/**
 * The selection after a click on an item. A plain click replaces; `additive` (Shift or Cmd/Ctrl)
 * toggles the item in a selection of the same kind.
 */
export function clickSelection(
  current: Selection,
  kind: "sections" | "tracks" | "clips",
  id: string,
  additive: boolean,
): Selection {
  if (additive && current.kind === kind) {
    const has = current.ids.includes(id);
    const ids = has ? current.ids.filter((existing) => existing !== id) : [...current.ids, id];
    return ids.length === 0 ? NO_SELECTION : { kind, ids };
  }
  return { kind, ids: [id] };
}

/** Drops ids that no longer exist (after a delete or an undo). */
export function pruneSelection(
  selection: Selection,
  exists: (kind: "sections" | "tracks" | "clips", id: string) => boolean,
): Selection {
  if (selection.kind === "none" || selection.kind === "region") return selection;
  const ids = selection.ids.filter((id) => exists(selection.kind as "sections", id));
  if (ids.length === selection.ids.length) return selection;
  return ids.length === 0 ? NO_SELECTION : { kind: selection.kind, ids };
}

/** Whether `id` is selected as `kind`. */
export function isSelected(
  selection: Selection,
  kind: "sections" | "tracks" | "clips",
  id: string,
): boolean {
  return selection.kind === kind && selection.ids.includes(id);
}
