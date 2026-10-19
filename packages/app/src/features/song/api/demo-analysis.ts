/**
 * Synthetic analysis results for the generated demo songs.
 *
 * The real energy, harmony and ribbon data arrive from the analysis workers (WP-1.2 to 1.7) and
 * are merged in by WP-1.10; until then the canvas needs something to draw that is *consistent with
 * the document*: ribbons that are loud exactly where a clip plays, an energy curve that follows
 * the part kinds, chords that follow the progression the demo audio plays. Everything here is
 * procedural and deterministic, so snapshots and benchmarks are repeatable.
 */
import {
  type AnalysisView,
  type CanvasDocument,
  type ChordSegment,
  type Curve,
  hash01,
  type PeakWindow,
  type RibbonData,
  type SectionKind,
  type StemRole,
} from "@bragi/render-canvas";

const KIND_ENERGY: Readonly<Record<SectionKind, number>> = {
  intro: 0.22,
  verse: 0.45,
  pre_chorus: 0.58,
  chorus: 0.86,
  post_chorus: 0.7,
  bridge: 0.5,
  breakdown: 0.3,
  build: 0.72,
  drop: 0.95,
  solo: 0.7,
  interlude: 0.35,
  outro: 0.18,
  custom: 0.5,
};

/** Brightness (spectral centroid) and noisiness (flatness) per role (07 §2 "texture"). */
const TIMBRE: Readonly<Partial<Record<StemRole, readonly [number, number]>>> = {
  drums: [0.7, 0.75],
  bass: [0.15, 0.05],
  guitar: [0.5, 0.25],
  piano: [0.6, 0.1],
  synth: [0.45, 0.15],
  strings: [0.4, 0.12],
  vocals: [0.55, 0.2],
  generated: [0.8, 0.3],
  fx: [0.65, 0.6],
};

/** A-minor progression the demo audio plays: Am F C G (i VI III VII). */
const PROGRESSION: readonly Pick<
  ChordSegment,
  "label" | "roman" | "rootPitchClass" | "quality" | "tension"
>[] = [
  { label: "Am", roman: "i", rootPitchClass: 9, quality: "minor", tension: 0 },
  { label: "F", roman: "VI", rootPitchClass: 5, quality: "major", tension: 0.4 },
  { label: "C", roman: "III", rootPitchClass: 0, quality: "major", tension: 0.2 },
  { label: "G", roman: "VII", rootPitchClass: 7, quality: "major", tension: 0.7 },
];

function smooth(values: Float32Array, passes: number): Float32Array {
  let current = values;
  for (let pass = 0; pass < passes; pass += 1) {
    const next = new Float32Array(current.length);
    for (let index = 0; index < current.length; index += 1) {
      const a = current[Math.max(0, index - 1)] ?? 0;
      const b = current[index] ?? 0;
      const c = current[Math.min(current.length - 1, index + 1)] ?? 0;
      next[index] = (a + 2 * b + c) / 4;
    }
    current = next;
  }
  return current;
}

/** The energy skyline curve: one value per half second, following the part kinds. */
export function syntheticEnergy(doc: CanvasDocument): Curve {
  const hopSec = 0.5;
  const count = Math.max(2, Math.ceil(doc.durationSec / hopSec) + 1);
  const values = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    const t = index * hopSec;
    const section = doc.sections.find(
      (candidate) => t >= candidate.startSec && t < candidate.endSec,
    );
    const base = section ? KIND_ENERGY[section.kind] : 0.2;
    values[index] = Math.min(1, Math.max(0, base + (hash01(index * 31 + 7) - 0.5) * 0.12));
  }
  return { values: smooth(values, 2), hopSec };
}

/** One chord per bar, following the A-minor progression. */
export function syntheticChords(doc: CanvasDocument): ChordSegment[] {
  const chords: ChordSegment[] = [];
  const beats = doc.beatTimesSec;
  const perBar = doc.beatsPerBar;
  for (let bar = 0; bar * perBar < beats.length; bar += 1) {
    const startSec = beats[bar * perBar] ?? 0;
    const endBeat = (bar + 1) * perBar;
    const endSec = endBeat < beats.length ? (beats[endBeat] ?? doc.durationSec) : doc.durationSec;
    const chord = PROGRESSION[bar % PROGRESSION.length];
    if (chord) chords.push({ startSec, endSec, ...chord });
  }
  return chords;
}

/** RMS, brightness and noisiness curves per visible track, loud only where a clip plays. */
export function syntheticRibbons(doc: CanvasDocument): Record<string, RibbonData> {
  const hopSec = 0.05;
  const count = Math.max(2, Math.ceil(doc.durationSec / hopSec) + 1);
  const secondsPerBeat = 60 / doc.bpm;
  const ribbons: Record<string, RibbonData> = {};
  const clipsByTrack = new Map<string, { startSec: number; endSec: number }[]>();
  for (const clip of doc.clips) {
    const list = clipsByTrack.get(clip.trackId) ?? [];
    list.push(clip);
    clipsByTrack.set(clip.trackId, list);
  }
  doc.tracks.forEach((track, trackIndex) => {
    if (track.hidden) return;
    const [brightBase, noiseBase] = TIMBRE[track.role] ?? [0.5, 0.2];
    const rms = new Float32Array(count);
    const brightness = new Float32Array(count);
    const noisiness = new Float32Array(count);
    const clips = clipsByTrack.get(track.id) ?? [];
    let clipIndex = 0;
    for (let index = 0; index < count; index += 1) {
      const t = index * hopSec;
      while (clipIndex < clips.length && (clips[clipIndex]?.endSec ?? 0) <= t) clipIndex += 1;
      const clip = clips[clipIndex];
      if (!clip || t < clip.startSec) continue;
      const section = doc.sections.find(
        (candidate) => t >= candidate.startSec && t < candidate.endSec,
      );
      const level = section ? 0.45 + 0.55 * KIND_ENERGY[section.kind] : 0.5;
      const beat = (t / secondsPerBeat) % 1;
      let shape: number;
      switch (track.role) {
        case "drums":
          shape = 0.35 + 0.65 * Math.exp(-beat * 6);
          break;
        case "bass":
          shape = 0.55 + 0.35 * Math.exp(-((t / secondsPerBeat) % 0.5) * 5);
          break;
        case "piano":
          shape = 0.3 + 0.5 * Math.exp(-((t / secondsPerBeat) % 0.5) * 7);
          break;
        default:
          shape = 0.5 + 0.2 * Math.sin(t * 0.9 + trackIndex);
      }
      rms[index] = Math.min(1, shape * level * (0.92 + 0.08 * hash01(index + trackIndex * 977)));
      brightness[index] = Math.min(1, brightBase + 0.2 * Math.sin(t * 0.4 + trackIndex));
      noisiness[index] = noiseBase;
    }
    ribbons[track.id] = {
      rms: { values: rms, hopSec },
      brightness: { values: brightness, hopSec },
      noisiness: { values: noisiness, hopSec },
    };
  });
  return ribbons;
}

/** Waveform peaks for the Moment level, procedural but shaped by the ribbon's RMS. */
export function syntheticPeaks(
  ribbons: Readonly<Record<string, RibbonData>>,
): NonNullable<AnalysisView["peaks"]> {
  return (trackId, startSec, endSec, bins): PeakWindow | null => {
    const data = ribbons[trackId];
    if (!data) return null;
    const min = new Float32Array(bins);
    const max = new Float32Array(bins);
    const dt = (endSec - startSec) / bins;
    for (let bin = 0; bin < bins; bin += 1) {
      const t = startSec + (bin + 0.5) * dt;
      const index = Math.min(
        data.rms.values.length - 1,
        Math.max(0, Math.round(t / data.rms.hopSec)),
      );
      const level = data.rms.values[index] ?? 0;
      const wobble = 0.55 + 0.45 * hash01(Math.round(t * 4000) + 13);
      max[bin] = level * wobble;
      min[bin] = -level * (0.55 + 0.45 * hash01(Math.round(t * 4000) + 91));
    }
    return { min, max };
  };
}

/** The whole analysis the demo songs show once every stage is done. */
export function syntheticAnalysis(
  doc: CanvasDocument,
  stages: AnalysisView["stages"],
): AnalysisView {
  const ribbons = syntheticRibbons(doc);
  return {
    stages,
    energy: syntheticEnergy(doc),
    chords: syntheticChords(doc),
    ribbons,
    peaks: syntheticPeaks(ribbons),
  };
}
