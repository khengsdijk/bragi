/**
 * The two generative offers that appear after an edit (07 §4.1, §4.8):
 *
 * - **Fill gap** after a region was cleared (`region.clear`, the Remove brush or a section clear).
 * - **✨ Smooth with AI** on the boundaries a section move/remove re-joined (smart transitions).
 *
 * The offers are derived from the history commit that produced them, not from a timer: the chip is
 * there exactly while that commit is HEAD, so an undo brings it back and an accept or a new edit
 * takes it away. Consecutive erase commits over the same bars are merged into one fill offer, so
 * erasing two stems with two strokes fills both (07 §4.8). Nothing here changes the document.
 */

import type { OpBatch, Project, Region } from "@bragi/schemas";
import { createStore, type StoreApi } from "zustand/vanilla";
import { t } from "../../../i18n/index.js";
import { meterAt, sectionStartTick } from "../../song/state/section-ops.js";

/** The erased gap the Fill gap chip offers (already the region the user cleared). */
export interface FillGapOffer {
  readonly region: Region;
  /** "Drums and Bass · bars 9–12", for the chip's title and the live region. */
  readonly label: string;
}

/** A new boundary after a move/remove; `sectionId` is the incoming section. */
export interface SmoothTarget {
  readonly sectionId: string;
  readonly boundaryTick: number;
}

export interface GenerationOffersState {
  readonly fill: FillGapOffer | null;
  readonly smooth: readonly SmoothTarget[];
}

export interface GenerationOffers {
  readonly store: StoreApi<GenerationOffersState>;
  /**
   * Recomputes both offers from HEAD's batch and, for the fill, the ancestor chain that may belong
   * to the same erase: HEAD first, parents after. An empty list means no commit.
   */
  consider(batches: readonly OpBatch[], doc: Project | null): void;
  clear(): void;
}

/** How many commits a merged Fill gap offer looks back through, HEAD included (07 §4.8). */
export const FILL_MERGE_COMMITS = 8;

const EMPTY: GenerationOffersState = { fill: null, smooth: [] };

/** A cleared span whose tracks are still a set, while ancestors are folded in. */
interface MergedClear {
  startTick: number;
  endTick: number;
  allTracks: boolean;
  trackIds: Set<string>;
}

/** The regions a batch clears, or `null` when the batch does anything else. */
function onlyClears(batch: OpBatch): Region[] | null {
  const regions: Region[] = [];
  for (const op of batch.ops) {
    if (op.op !== "region.clear") return null;
    regions.push(op.region);
  }
  return regions.length === 0 ? null : regions;
}

/** Whether a cleared span overlaps the merged one or shares an edge with it. */
function touches(merged: MergedClear, region: Region): boolean {
  return region.endTick >= merged.startTick && merged.endTick >= region.startTick;
}

function absorb(merged: MergedClear, region: Region): void {
  merged.startTick = Math.min(merged.startTick, region.startTick);
  merged.endTick = Math.max(merged.endTick, region.endTick);
  if (region.tracks === "all") {
    merged.allTracks = true;
    return;
  }
  for (const id of region.tracks) merged.trackIds.add(id);
}

/** The merged span as a region: document track order, so the label reads consistently. */
function mergedRegion(doc: Project, merged: MergedClear): Region {
  if (merged.allTracks) {
    return { startTick: merged.startTick, endTick: merged.endTick, tracks: "all" };
  }
  const known = doc.tracks
    .filter((track) => merged.trackIds.has(track.id))
    .map((track) => track.id);
  const unknown = [...merged.trackIds].filter((id) => !known.includes(id));
  return { startTick: merged.startTick, endTick: merged.endTick, tracks: [...known, ...unknown] };
}

/**
 * HEAD's clears merged with the erase commits directly behind it. An ancestor joins while it is a
 * user edit of only `region.clear` ops whose range touches the span so far; anything else ends the
 * chain, so a move, a trim or an unrelated edit in between leaves only the latest stroke.
 */
function mergedClear(doc: Project, batches: readonly OpBatch[]): Region | null {
  const chain = batches.slice(0, FILL_MERGE_COMMITS);
  const head = chain[0];
  if (head === undefined) return null;
  const headClears = head.ops.flatMap((op) => (op.op === "region.clear" ? [op.region] : []));
  const first = headClears[0];
  if (first === undefined) return null;
  const merged: MergedClear = {
    startTick: first.startTick,
    endTick: first.endTick,
    allTracks: false,
    trackIds: new Set(),
  };
  for (const region of headClears) absorb(merged, region);
  for (const batch of chain.slice(1)) {
    const clears = onlyClears(batch);
    if (clears === null || batch.author.kind !== "user") break;
    if (!clears.some((region) => touches(merged, region))) break;
    for (const region of clears) absorb(merged, region);
  }
  return mergedRegion(doc, merged);
}

/** The track names of a cleared region, as the label's subject. */
function trackNames(doc: Project, region: Region): string[] {
  const ids = region.tracks === "all" ? doc.tracks.map((track) => track.id) : region.tracks;
  return doc.tracks.filter((track) => ids.includes(track.id)).map((track) => track.name);
}

/** "Drums and Bass · bars 9–12". */
function fillLabel(doc: Project, region: Region): string {
  const names = trackNames(doc, region);
  const last = names.at(-1);
  const tracks =
    last === undefined
      ? t("song.selection.whole")
      : names.length === 1
        ? last
        : t("brush.tracks.and", { list: names.slice(0, -1).join(", "), last });
  const from = meterAt(doc, region.startTick).bar + 1;
  const to = meterAt(doc, Math.max(region.startTick, region.endTick - 1)).bar + 1;
  return from === to
    ? t("generation.fill.label.oneBar", { tracks, bar: from })
    : t("generation.fill.label", { tracks, from, to });
}

/** The boundaries a batch re-joined: the sections its smart transitions set. */
function smoothTargets(batch: OpBatch, doc: Project): SmoothTarget[] {
  const targets: SmoothTarget[] = [];
  for (const op of batch.ops) {
    if (op.op !== "section.set_transition") continue;
    const index = doc.arrangement.sections.findIndex((section) => section.id === op.sectionId);
    if (index <= 0) continue;
    targets.push({ sectionId: op.sectionId, boundaryTick: sectionStartTick(doc, index) });
  }
  return targets;
}

/** Creates the offers store of one canvas. */
export function createGenerationOffers(): GenerationOffers {
  const store = createStore<GenerationOffersState>(() => EMPTY);

  return {
    store,
    consider(batches, doc) {
      const head = batches[0];
      if (head === undefined || doc === null) {
        store.setState(EMPTY);
        return;
      }
      const cleared = mergedClear(doc, batches);
      store.setState({
        fill: cleared === null ? null : { region: cleared, label: fillLabel(doc, cleared) },
        smooth: smoothTargets(head, doc),
      });
    },
    clear() {
      store.setState(EMPTY);
    },
  };
}
