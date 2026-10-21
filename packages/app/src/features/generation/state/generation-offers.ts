/**
 * The two generative offers that appear after an edit (07 §4.1, §4.8):
 *
 * - **Fill gap** after a region was cleared (`region.clear`, the Remove brush or a section clear).
 * - **✨ Smooth with AI** on the boundaries a section move/remove re-joined (smart transitions).
 *
 * The offers are derived from the history commit that produced them, not from a timer: the chip is
 * there exactly while that commit is HEAD, so an undo brings it back and an accept or a new edit
 * takes it away. Nothing here changes the document.
 */
import type { StoredCommit } from "../../history/api/history-repo.js";
import { createStore, type StoreApi } from "zustand/vanilla";

import { t } from "../../../i18n/index.js";
import type { OpBatch, Project, Region } from "@bragi/schemas";
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
  /** Recomputes both offers from the commit that is HEAD now (or `null`). */
  consider(commit: Pick<StoredCommit, "batch"> | null, doc: Project | null): void;
  clear(): void;
}

const EMPTY: GenerationOffersState = { fill: null, smooth: [] };

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
    consider(commit, doc) {
      if (commit === null || doc === null) {
        store.setState(EMPTY);
        return;
      }
      const cleared = commit.batch.ops.find((op) => op.op === "region.clear");
      store.setState({
        fill:
          cleared === undefined
            ? null
            : { region: cleared.region, label: fillLabel(doc, cleared.region) },
        smooth: smoothTargets(commit.batch, doc),
      });
    },
    clear() {
      store.setState(EMPTY);
    },
  };
}
