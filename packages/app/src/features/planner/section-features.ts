/**
 * Per-section features for the planner request (docs/wp/2.6.md task D, fixes task A's gap).
 *
 * Energy, chords and stemming activity live in the analysis blobs, which `bragi-model` never
 * reads, so `summarize_for_llm` prints `-` for them. The canvas already projects those blobs; this
 * module condenses that same view into the bounded `sectionFeatures` the request carries. Pure, so
 * the projection is unit-tested with a hand-made view.
 */
import type { AnalysisView, Curve } from "@bragi/render-canvas";
import type {
  Project,
  SectionActiveStemList,
  SectionChordList,
  SectionFeatures,
} from "@bragi/schemas";

/** The canvas analysis data without the stage map (the app's `AnalysisData`). */
export type PlannerAnalysis = Omit<AnalysisView, "stages">;

/** The schema's cap on sections per request. */
export const SECTION_FEATURE_LIMIT = 64;

/** The schema's cap on chord symbols per section. */
export const SECTION_CHORD_LIMIT = 8;

/** The schema's cap on active stems per section. */
export const SECTION_STEM_LIMIT = 16;

/** A stem counts as active over a section when its mean ribbon thickness reaches this. */
const ACTIVE_THRESHOLD = 0.2;

/** Mean of a sampled curve over `[startSec, endSec)`; `undefined` when the range is empty. */
function meanCurve(curve: Curve, startSec: number, endSec: number): number | undefined {
  const count = curve.values.length;
  if (count === 0 || endSec <= startSec || curve.hopSec <= 0) return undefined;
  const from = Math.max(0, Math.floor(startSec / curve.hopSec));
  const to = Math.min(count - 1, Math.ceil(endSec / curve.hopSec) - 1);
  if (to < from) return undefined;
  let sum = 0;
  for (let index = from; index <= to; index += 1) sum += curve.values[index] ?? 0;
  return Math.min(1, Math.max(0, sum / (to - from + 1)));
}

/**
 * The compact features of every section, or `[]` when no analysis has arrived.
 *
 * @param doc the song document (sections are ordered; starts are cumulative `lengthTicks`)
 * @param analysis the canvas's analysis view
 * @param secondsAtTick tempo-map conversion, so energy and chords line up with section seconds
 */
export function sectionFeaturesFor(
  doc: Project,
  analysis: PlannerAnalysis | null,
  secondsAtTick: (tick: number) => number,
): SectionFeatures[] {
  if (analysis === null) return [];
  const hasAny =
    analysis.energy !== undefined ||
    (analysis.chords !== undefined && analysis.chords.length > 0) ||
    (analysis.ribbons !== undefined && Object.keys(analysis.ribbons).length > 0);
  if (!hasAny) return [];

  const tracks = doc.tracks.filter((track) => !track.hidden);
  const features: SectionFeatures[] = [];
  let startTick = 0;
  for (const section of doc.arrangement.sections.slice(0, SECTION_FEATURE_LIMIT)) {
    const endTick = startTick + Math.max(0, section.lengthTicks);
    const startSec = secondsAtTick(startTick);
    const endSec = secondsAtTick(endTick);

    const feature: { -readonly [K in keyof SectionFeatures]: SectionFeatures[K] } = {
      sectionId: section.id,
    };
    const energy =
      analysis.energy === undefined ? undefined : meanCurve(analysis.energy, startSec, endSec);
    if (energy !== undefined) feature.energy = energy;

    const chords = analysis.chords
      ?.filter((chord) => chord.endSec > startSec && chord.startSec < endSec)
      .map((chord) => chord.label);
    if (chords !== undefined && chords.length > 0) {
      feature.chords = chordList([...new Set(chords)]);
    }

    if (analysis.ribbons !== undefined) {
      const active: string[] = [];
      for (const track of tracks) {
        const ribbon = analysis.ribbons[track.id];
        if (ribbon === undefined) continue;
        const thickness = meanCurve(ribbon.rms, startSec, endSec);
        if (thickness !== undefined && thickness >= ACTIVE_THRESHOLD) active.push(track.id);
      }
      if (active.length > 0) feature.activeStems = stemList(active);
    }

    features.push(feature);
    startTick = endTick;
  }
  return features;
}

/** The schema models a bounded list as a tuple union; this is the checked narrowing. */
function chordList(values: readonly string[]): SectionChordList {
  return values.slice(0, SECTION_CHORD_LIMIT) as SectionChordList;
}

function stemList(values: readonly string[]): SectionActiveStemList {
  return values.slice(0, SECTION_STEM_LIMIT) as SectionActiveStemList;
}
