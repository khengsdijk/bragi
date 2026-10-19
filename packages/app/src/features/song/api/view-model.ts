/**
 * Song document -> what the canvas draws.
 *
 * Tick/second conversion is `bragi-model`'s job (02 §2.2: "the only allowed conversions"), so every
 * time in the result comes from the wasm tempo map. The result is plain data (`CanvasDocument`),
 * which is also what the accessible grid is built from: the DOM and the canvas cannot disagree
 * because they read the same object.
 */
import type {
  AnalysisStageName,
  AnalysisView,
  CanvasClip,
  CanvasDocument,
  CanvasSection,
  CanvasTrack,
  SectionKind,
  StageStatus,
  StemRole,
} from "@bragi/render-canvas";
import type { Project } from "@bragi/schemas";

import type { ModelApi } from "../model/model-api.js";

const SAMPLE_RATE = 48000;

interface SpanJson {
  readonly id: string;
  readonly index: number;
  readonly startTick: number;
  readonly endTick: number;
  readonly lengthTicks: number;
}

/** Strips a trailing number: "Chorus 2" -> "chorus" (a repeat shares its stem). */
function repeatStem(label: string): string {
  return label
    .replace(/[\s_-]*\d+$/, "")
    .trim()
    .toLowerCase();
}

/**
 * The repeat group of each section: sections whose labels differ only by a trailing number
 * ("Chorus 1", "Chorus 2") or that are copies of each other (`derivedFrom`) repeat (07 §2).
 * A section that appears once gets no group.
 */
export function repeatGroups(doc: Project): ReadonlyMap<string, string> {
  const byStem = new Map<string, string[]>();
  for (const section of doc.arrangement.sections) {
    if (section.kind === "custom") continue;
    const stem = `${section.kind}:${repeatStem(section.label)}`;
    const list = byStem.get(stem) ?? [];
    list.push(section.id);
    byStem.set(stem, list);
  }
  const groups = new Map<string, string>();
  for (const [stem, ids] of byStem) {
    if (ids.length < 2) continue;
    for (const id of ids) groups.set(id, stem);
  }
  // Copies join the group of the section they were made from.
  for (const section of doc.arrangement.sections) {
    const origin = section.derivedFrom;
    if (origin === undefined || groups.has(section.id)) continue;
    const group = groups.get(origin) ?? `copy:${origin}`;
    groups.set(section.id, group);
    groups.set(origin, group);
  }
  return groups;
}

/** Builds the canvas view of `doc`, which must be the document behind `handle`. */
export function buildCanvasDocument(model: ModelApi, handle: number, doc: Project): CanvasDocument {
  const spans = JSON.parse(model.sectionSpans(handle)) as SpanJson[];
  const sec = (ticks: number): number => model.ticksToSeconds(handle, BigInt(Math.round(ticks)));
  const timebase = doc.arrangement.timebase;
  const signature = timebase.timeSignatures[0];
  const numerator = signature?.numerator ?? 4;
  const denominator = signature?.denominator ?? 4;
  const ticksPerBeat = (timebase.ppq * 4) / denominator;
  const bpm = timebase.tempoMap[0]?.bpm ?? 120;
  const totalTicks = spans.length === 0 ? 0 : (spans[spans.length - 1]?.endTick ?? 0);

  const groups = repeatGroups(doc);
  const spanById = new Map(spans.map((span) => [span.id, span]));
  const sections: CanvasSection[] = doc.arrangement.sections.map((section) => {
    const span = spanById.get(section.id);
    const startTick = span?.startTick ?? 0;
    const endTick = span?.endTick ?? startTick + section.lengthTicks;
    const group = groups.get(section.id);
    return {
      id: section.id,
      kind: section.kind as SectionKind,
      label: section.label,
      startSec: sec(startTick),
      endSec: sec(endTick),
      bars: Math.max(1, Math.round(section.lengthTicks / (ticksPerBeat * numerator))),
      locked: section.locked === true,
      ...(group === undefined ? {} : { repeatGroup: group }),
    };
  });

  const tracks: CanvasTrack[] = doc.tracks.map((track) => ({
    id: track.id,
    name: track.name,
    role: track.role as StemRole,
    mute: track.mute,
    solo: track.solo,
    hidden: track.hidden,
  }));

  const clips: CanvasClip[] = [];
  doc.arrangement.sections.forEach((section, index) => {
    const startTick = spans[index]?.startTick ?? 0;
    const sectionEnd = sections[index]?.endSec ?? 0;
    for (const [trackId, lane] of Object.entries(section.lanes)) {
      for (const clip of lane.clips) {
        const startSec = sec(startTick + clip.start);
        // A clip at source speed ends where its source does; warped clips fill their section.
        const natural =
          clip.warp.mode === "none"
            ? startSec + (clip.srcEnd - clip.srcStart) / SAMPLE_RATE
            : sectionEnd;
        clips.push({
          trackId,
          sectionId: section.id,
          startSec,
          endSec: Math.min(sectionEnd, natural),
        });
      }
    }
  });

  const beatTimesSec: number[] = [];
  if (timebase.tempoMap.length > 0) {
    for (let tick = 0; tick < totalTicks; tick += ticksPerBeat) beatTimesSec.push(sec(tick));
  }

  return {
    id: doc.id,
    title: doc.meta.title,
    durationSec: sec(totalTicks),
    bpm,
    beatsPerBar: numerator,
    beatTimesSec,
    sections,
    tracks,
    clips,
  };
}

const STAGES: readonly AnalysisStageName[] = [
  "ingest",
  "rhythm",
  "loudness_energy",
  "structure",
  "separation",
  "harmony",
  "tag",
  "describe",
];

/**
 * The analysis stage statuses recorded in the document (`analyses[source].status`, 02 §3.3).
 * With several sources the stage is `done` only when every source has it done.
 */
export function stagesFromDocument(
  doc: Project,
): Readonly<Partial<Record<AnalysisStageName, StageStatus>>> {
  const out: Partial<Record<AnalysisStageName, StageStatus>> = {};
  const refs = Object.values(doc.analyses);
  for (const stage of STAGES) {
    let combined: StageStatus | undefined;
    for (const ref of refs) {
      const status = (ref.status as Partial<Record<string, StageStatus>>)[stage];
      if (status === undefined) continue;
      if (combined === undefined || rank(status) < rank(combined)) combined = status;
    }
    if (combined !== undefined) out[stage] = combined;
  }
  return out;
}

/** Lower is "less done": failed < running < pending < done. */
function rank(status: StageStatus): number {
  return { failed: 0, running: 1, pending: 2, done: 3 }[status];
}

/** The document's stage table merged with the analysis data that has arrived. */
export function analysisView(
  doc: Project,
  data: Omit<AnalysisView, "stages"> | null,
): AnalysisView {
  return { stages: stagesFromDocument(doc), ...(data ?? {}) };
}
