/**
 * Progressive states (07 §8): which layers of the canvas are live, which are still waiting for
 * their analysis stage (and draw a shimmer placeholder, never a spinner), and which stage failed.
 *
 * A layer is **live** when its data is there, whatever the stage table says: the document is the
 * truth, and the status is only used to explain an absence.
 */
import type { AnalysisStageName, AnalysisView, CanvasDocument, StageStatus } from "./types.js";

export type LayerName = "grid" | "skyline" | "sections" | "stems" | "harmony";

/** `absent` draws nothing; `pending` draws a shimmer; `failed` draws a quiet dash. */
export type LayerState = "live" | "pending" | "failed" | "absent";

/** The stage that fills each layer (07 §8 table). */
export const LAYER_STAGE: Readonly<Record<LayerName, AnalysisStageName>> = {
  grid: "rhythm",
  skyline: "loudness_energy",
  sections: "structure",
  stems: "separation",
  harmony: "harmony",
};

function waiting(status: StageStatus | undefined): LayerState {
  if (status === "pending" || status === "running") return "pending";
  if (status === "failed") return "failed";
  return "absent";
}

/** True when a track is an instrument ribbon rather than the reference full mix. */
function isStem(role: string): boolean {
  return role !== "full_mix" && role !== "residual";
}

/** The state of every layer for a document and the analysis that has arrived. */
export function layerStates(
  doc: CanvasDocument,
  analysis: AnalysisView | null,
): Record<LayerName, LayerState> {
  const status = (layer: LayerName): StageStatus | undefined =>
    analysis?.stages[LAYER_STAGE[layer]];
  const hasStems = doc.tracks.some((track) => !track.hidden && isStem(track.role));
  return {
    grid: doc.beatTimesSec.length > 0 ? "live" : waiting(status("grid")),
    skyline: analysis?.energy ? "live" : waiting(status("skyline")),
    sections: doc.sections.length > 1 ? "live" : waiting(status("sections")),
    stems: hasStems ? "live" : waiting(status("stems")),
    harmony: analysis?.chords && analysis.chords.length > 0 ? "live" : waiting(status("harmony")),
  };
}

/** True while any stage is still pending or running. */
export function isAnalysing(analysis: AnalysisView | null): boolean {
  if (!analysis) return false;
  return Object.values(analysis.stages).some(
    (status) => status === "pending" || status === "running",
  );
}

/**
 * Ids present in `next` but not in `previous`: the sections that just cracked out of the block
 * and the ribbons that just unwove from the full mix, which the canvas animates in (07 §8).
 */
export function appeared(previous: readonly string[], next: readonly string[]): string[] {
  const before = new Set(previous);
  return next.filter((id) => !before.has(id));
}

/** The shimmer's brightness (0..1) at `timeMs`: a slow sweep, still when motion is reduced. */
export function shimmerPhase(timeMs: number, x: number, reducedMotion: boolean): number {
  if (reducedMotion) return 0.5;
  const sweep = (timeMs / 1600 + x / 600) % 1;
  return 0.5 + 0.5 * Math.sin(sweep * Math.PI * 2);
}
