/**
 * Analysis blobs -> the canvas's `AnalysisView` data (07 §2, §8; Q57).
 *
 * The document owns the arrangement (sections, tracks, clips) through
 * `analysis.apply`. Everything else the canvas draws — the energy skyline, the
 * harmony strip, ribbon thickness and waveform peaks — is *view* data and
 * deliberately not in the song document, so it is projected straight from the
 * blobs here.
 *
 * Two approximations are explicit (Q57):
 * - Ribbon thickness comes from `stem_activity`'s gated regions, not from
 *   per-stem RMS/brightness/noisiness curves (those need `energy_stems` or the
 *   engine's peaks). A ribbon is opaque where its stem is active.
 * - The peak pyramid is the mono mix from `ingest`, served for every track.
 */

import type {
  AnalysisView,
  ChordSegment,
  Curve,
  PeakWindow,
  RibbonData,
  StemRole,
} from "@bragi/render-canvas";
import {
  type IngestResult,
  validateHarmonyResult,
  validateIngestResult,
  validateLoudnessEnergyResult,
  validateStemActivityResult,
} from "@bragi/schemas";

/** The part of a track the ribbon projection needs. */
export interface TrackRef {
  readonly id: string;
  readonly role: StemRole;
}

/** What the projections need beyond the blob: the document's tracks. */
export interface AnalysisContext {
  readonly tracks: readonly TrackRef[];
}

/** A stage's contribution to the view; every field is optional. */
export interface StageArtifacts {
  readonly energy?: Curve;
  readonly chords?: readonly ChordSegment[];
  readonly ribbons?: Readonly<Record<string, RibbonData>>;
  readonly peaks?: NonNullable<AnalysisView["peaks"]>;
}

const NOTE_PITCH: Readonly<Record<string, number>> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

/** `"F#"` → 6, `"Bb"` → 10, `"C"` → 0; unknown names fall back to C. */
export function pitchClass(note: string): number {
  const letter = note.trim().charAt(0).toUpperCase();
  const base = NOTE_PITCH[letter];
  if (base === undefined) return 0;
  let accidental = 0;
  for (const char of note.slice(1)) {
    if (char === "#" || char === "♯") accidental += 1;
    else if (char === "b" || char === "♭") accidental -= 1;
  }
  return (((base + accidental) % 12) + 12) % 12;
}

/** A chord-quality string from the blob → the canvas's four outline classes. */
export function chordQuality(quality: string): ChordSegment["quality"] {
  const value = quality.toLowerCase();
  if (value.includes("dim")) return "diminished";
  if (value.includes("sus") || value.includes("aug")) return "suspended";
  if (value.includes("min") || value === "m") return "minor";
  return "major";
}

/** 0 (close to the tonic) .. 1 (tense), from the chord quality. */
const TENSION: Readonly<Record<ChordSegment["quality"], number>> = {
  major: 0.25,
  minor: 0.15,
  suspended: 0.55,
  diminished: 0.85,
};

/** The energy skyline, one value per 0.5 s hop (`LoudnessEnergyResult.energy`). */
export function energyCurve(blob: unknown): Curve | undefined {
  if (!validateLoudnessEnergyResult(blob)) return undefined;
  const result = blob;
  if (result.energy.length === 0) return undefined;
  return { values: Float32Array.from(result.energy), hopSec: result.hopSec };
}

/** The harmony strip, from `HarmonyResult.chords`. */
export function chordsFromHarmony(blob: unknown): ChordSegment[] | undefined {
  if (!validateHarmonyResult(blob)) return undefined;
  const result = blob;
  if (result.chords.length === 0) return undefined;
  return result.chords.map((chord): ChordSegment => {
    const quality = chordQuality(chord.quality);
    return {
      startSec: chord.startSec,
      endSec: chord.endSec,
      label: chord.symbol,
      rootPitchClass: pitchClass(chord.root),
      quality,
      tension: TENSION[quality],
    };
  });
}

/** Per-role texture constants for the ribbon approximation (07 §2). */
const TEXTURE: Readonly<Partial<Record<StemRole, readonly [number, number]>>> = {
  drums: [0.7, 0.75],
  bass: [0.15, 0.05],
  guitar: [0.5, 0.25],
  piano: [0.6, 0.1],
  synth: [0.45, 0.15],
  strings: [0.4, 0.12],
  vocals: [0.55, 0.2],
  other: [0.5, 0.2],
};

/** The hop of the approximated ribbon curves, in seconds. */
const RIBBON_HOP_SEC = 0.25;

/**
 * Ribbon thickness from `stem_activity`: 1 where the stem is gated open, 0
 * elsewhere. Brightness and noisiness are per-role constants.
 */
export function ribbonsFromStemActivity(
  blob: unknown,
  context: AnalysisContext,
): Record<string, RibbonData> | undefined {
  if (!validateStemActivityResult(blob)) return undefined;
  const result = blob;
  if (result.stems.length === 0) return undefined;

  const byRole = new Map(result.stems.map((stem) => [stem.role, stem.active]));
  const end = Math.max(
    0,
    ...result.stems.flatMap((stem) => stem.active.map((range) => range.endSec)),
  );
  if (end <= 0) return undefined;
  const count = Math.max(2, Math.ceil(end / RIBBON_HOP_SEC) + 1);

  const ribbons: Record<string, RibbonData> = {};
  for (const track of context.tracks) {
    const active = byRole.get(track.role);
    if (active === undefined) continue;
    const [brightBase, noiseBase] = TEXTURE[track.role] ?? [0.5, 0.2];
    const rms = new Float32Array(count);
    const brightness = new Float32Array(count);
    const noisiness = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
      const t = index * RIBBON_HOP_SEC;
      rms[index] = active.some((range) => t >= range.startSec && t < range.endSec) ? 1 : 0;
      brightness[index] = brightBase;
      noisiness[index] = noiseBase;
    }
    ribbons[track.id] = {
      rms: { values: rms, hopSec: RIBBON_HOP_SEC },
      brightness: { values: brightness, hopSec: RIBBON_HOP_SEC },
      noisiness: { values: noisiness, hopSec: RIBBON_HOP_SEC },
    };
  }
  return Object.keys(ribbons).length === 0 ? undefined : ribbons;
}

/**
 * The `peaks` callback from `IngestResult.peakPyramid` (04 §3.1).
 *
 * The pyramid is the mono working mix, so every track draws the same envelope;
 * per-stem peaks need the engine's `min/max` pyramids (Q57).
 */
export function peaksFromIngest(
  blob: unknown,
  sampleRate = 48_000,
): NonNullable<AnalysisView["peaks"]> | undefined {
  if (!validateIngestResult(blob)) return undefined;
  const result: IngestResult = blob;
  const level = firstPeakLevel(result.peakPyramid);
  if (level === undefined) return undefined;
  const secondsPerPeak = level.samplesPerPeak / sampleRate;
  const peaks = level.peaks;
  return (_trackId, startSec, endSec, bins): PeakWindow | null => {
    const min = new Float32Array(bins);
    const max = new Float32Array(bins);
    const dt = (endSec - startSec) / bins;
    if (dt <= 0) return null;
    for (let bin = 0; bin < bins; bin += 1) {
      const t = startSec + (bin + 0.5) * dt;
      const peakIndex = Math.max(0, Math.floor(t / secondsPerPeak));
      const low = peaks[peakIndex * 2];
      const high = peaks[peakIndex * 2 + 1];
      min[bin] = low ?? 0;
      max[bin] = high ?? 0;
    }
    return { min, max };
  };
}

interface PeakLevel {
  readonly samplesPerPeak: number;
  readonly peaks: readonly number[];
}

/** The first (finest) level of the open-ended `peakPyramid` freeform object. */
function firstPeakLevel(
  pyramid: Readonly<Record<string, unknown>> | undefined,
): PeakLevel | undefined {
  const levels = pyramid?.levels;
  if (!Array.isArray(levels)) return undefined;
  const first: unknown = levels[0];
  if (typeof first !== "object" || first === null) return undefined;
  const { samplesPerPeak, peaks } = first as { samplesPerPeak?: unknown; peaks?: unknown };
  if (typeof samplesPerPeak !== "number" || samplesPerPeak <= 0 || !Array.isArray(peaks)) {
    return undefined;
  }
  const values = peaks.filter((value): value is number => typeof value === "number");
  return values.length < 2 ? undefined : { samplesPerPeak, peaks: values };
}

/**
 * The view contribution of one finished stage, or `{}` for a stage the canvas
 * draws from the document alone.
 */
export function artifactsForStage(
  stage: string,
  blob: unknown,
  context: AnalysisContext,
): StageArtifacts {
  switch (stage) {
    case "ingest": {
      const peaks = peaksFromIngest(blob);
      return peaks === undefined ? {} : { peaks };
    }
    case "loudness_energy": {
      const energy = energyCurve(blob);
      return energy === undefined ? {} : { energy };
    }
    case "harmony": {
      const chords = chordsFromHarmony(blob);
      return chords === undefined ? {} : { chords };
    }
    case "stem_activity": {
      const ribbons = ribbonsFromStemActivity(blob, context);
      return ribbons === undefined ? {} : { ribbons };
    }
    default:
      return {};
  }
}

/** Merges a stage's artefacts into the view the canvas holds. */
export function mergeArtifacts(current: StageArtifacts, next: StageArtifacts): StageArtifacts {
  const merged: StageArtifacts = { ...current, ...next };
  if (current.ribbons !== undefined || next.ribbons !== undefined) {
    return {
      ...merged,
      ribbons: { ...(current.ribbons ?? {}), ...(next.ribbons ?? {}) },
    };
  }
  return merged;
}
