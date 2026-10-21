/**
 * Turning the app's target into the API's `PlanRequest` (06 §2, docs/wp/2.6.md).
 *
 * The request carries the current document (the server holds no projects) and the region in
 * absolute ticks. `uiContext` mirrors that region so the planner's summariser focuses the same
 * tracks and parts. `sectionFeatures` fills the analysis gap task A documented: the model never
 * reads analysis blobs, so energy, chords and active stems travel alongside the document.
 */
import type { PlanRequest, Project, Region } from "@bragi/schemas";

import { type PlannerAnalysis, sectionFeaturesFor } from "./section-features.js";

/** The schema's default variant count (06 §3), the app's "number of version ideas" (11 §9). */
export const DEFAULT_VARIANT_COUNT = 3;

export interface PlanRequestInput {
  readonly doc: Project;
  readonly prompt: string;
  readonly region: Region;
  readonly analysis: PlannerAnalysis | null;
  readonly explain?: boolean;
  readonly secondsAtTick: (tick: number) => number;
}

/** Section ids whose absolute span overlaps `region`. */
export function sectionsInRegion(doc: Project, region: Region): string[] {
  const ids: string[] = [];
  let startTick = 0;
  for (const section of doc.arrangement.sections) {
    const endTick = startTick + section.lengthTicks;
    if (endTick > region.startTick && startTick < region.endTick) ids.push(section.id);
    startTick = endTick;
  }
  return ids;
}

/** The request the prompt bar sends. */
export function buildPlanRequest(input: PlanRequestInput): PlanRequest {
  const features = sectionFeaturesFor(input.doc, input.analysis, input.secondsAtTick);
  return {
    doc: input.doc,
    prompt: input.prompt,
    region: input.region,
    uiContext: {
      view: "song",
      selectedTrackIds: input.region.tracks === "all" ? [] : [...input.region.tracks],
      selectedSectionIds: sectionsInRegion(input.doc, input.region),
    },
    variantCount: DEFAULT_VARIANT_COUNT,
    ...(input.explain === true ? { explain: true } : {}),
    ...(features.length === 0 ? {} : { sectionFeatures: features }),
  };
}
