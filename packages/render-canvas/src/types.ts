/**
 * The data-in and events-out contract of the Song Canvas (07 §9, WP-1.10's seam).
 *
 * Everything here is plain data: no document handle, no React, no engine. The app
 * derives a {@link CanvasDocument} from the song document (through `bragi-model`, so tick
 * to second conversion stays in one place) and feeds analysis results in through
 * {@link AnalysisView} as they arrive. The renderer answers with {@link CanvasEvents}.
 */

/** [02 §3.5] */
export type SectionKind =
  | "intro"
  | "verse"
  | "pre_chorus"
  | "chorus"
  | "post_chorus"
  | "bridge"
  | "breakdown"
  | "build"
  | "drop"
  | "solo"
  | "interlude"
  | "outro"
  | "custom";

/** [02 §3.4] */
export type StemRole =
  | "vocals"
  | "drums"
  | "bass"
  | "guitar"
  | "piano"
  | "synth"
  | "strings"
  | "other"
  | "residual"
  | "full_mix"
  | "generated"
  | "fx"
  | "recorded";

/** The analysis stages the canvas shows progressively (07 §8). Names are the 02 §6 stage names. */
export type AnalysisStageName =
  | "ingest"
  | "rhythm"
  | "loudness_energy"
  | "structure"
  | "separation"
  | "harmony"
  | "tag"
  | "describe";

/** [02 §3.3] */
export type StageStatus = "pending" | "running" | "done" | "failed";

/** One section of the arrangement, with its derived absolute span. */
export interface CanvasSection {
  readonly id: string;
  readonly kind: SectionKind;
  readonly label: string;
  /** Absolute start in seconds, from the tempo map. */
  readonly startSec: number;
  readonly endSec: number;
  /** Whole bars the section spans (rounded), for the accessible grid. */
  readonly bars: number;
  readonly locked: boolean;
  /**
   * Sections that repeat each other share a group; the renderer gives each group a glyph (07 §2).
   * Absent when the section has no repeat.
   */
  readonly repeatGroup?: string;
}

/** One instrument lane. */
export interface CanvasTrack {
  readonly id: string;
  readonly name: string;
  readonly role: StemRole;
  readonly mute: boolean;
  readonly solo: boolean;
  /** Hidden tracks (the full mix after separation, the residual) get no ribbon. */
  readonly hidden: boolean;
}

/** Where a track has audio: one entry per clip, in absolute seconds. */
export interface CanvasClip {
  readonly trackId: string;
  readonly sectionId: string;
  readonly startSec: number;
  readonly endSec: number;
}

/** The arrangement as the renderer sees it. */
export interface CanvasDocument {
  readonly id: string;
  readonly title: string;
  readonly durationSec: number;
  /** The first tempo, for the px-per-beat zoom scale. */
  readonly bpm: number;
  readonly beatsPerBar: number;
  /** Absolute beat times in seconds, ascending. Empty in free-time mode: the grid is hidden. */
  readonly beatTimesSec: ArrayLike<number>;
  readonly sections: readonly CanvasSection[];
  readonly tracks: readonly CanvasTrack[];
  readonly clips: readonly CanvasClip[];
}

/** A chord segment on the harmony strip (07 §2). */
export interface ChordSegment {
  readonly startSec: number;
  readonly endSec: number;
  /** `F#m`. */
  readonly label: string;
  /** Roman numeral in Learn mode, when known. */
  readonly roman?: string;
  /** Root pitch class: 0 = C ... 11 = B. The hue follows the circle of fifths. */
  readonly rootPitchClass: number;
  readonly quality: "major" | "minor" | "diminished" | "suspended";
  /** 0 = tonic, 1 = far from the tonic. Drives the outline glow. */
  readonly tension: number;
}

/** A sampled curve (energy, RMS, brightness) on a fixed hop. */
export interface Curve {
  readonly values: ArrayLike<number>;
  /** Seconds between two values. */
  readonly hopSec: number;
}

/** What one ribbon draws (07 §2). All curves are 0..1. */
export interface RibbonData {
  /** Short-term RMS: the ribbon's thickness. */
  readonly rms: Curve;
  /** Spectral centroid, normalised: the ribbon's lightness. */
  readonly brightness?: Curve;
  /** Spectral flatness: the ribbon's grain. */
  readonly noisiness?: Curve;
}

/** Waveform peaks for the L3 Moment level (07 §2.1). */
export interface PeakWindow {
  readonly min: Float32Array;
  readonly max: Float32Array;
}

/**
 * The analysis results the canvas can show. Every field is optional because stages arrive
 * one by one; the renderer draws a shimmer placeholder for a stage that has not arrived yet.
 */
export interface AnalysisView {
  /** Per-stage status; a missing key means "not part of this analysis". */
  readonly stages: Readonly<Partial<Record<AnalysisStageName, StageStatus>>>;
  /** The energy skyline curve (07 §2). */
  readonly energy?: Curve;
  /** The harmony strip. */
  readonly chords?: readonly ChordSegment[];
  /** Ribbon data by track id. */
  readonly ribbons?: Readonly<Record<string, RibbonData>>;
  /** Pulls `bins` peak pairs over `[startSec, endSec]` for a track (L3). */
  readonly peaks?: (
    trackId: string,
    startSec: number,
    endSec: number,
    bins: number,
  ) => PeakWindow | null;
  /** The user's drawn energy target, as a curve; shown dashed when it differs (07 §2). */
  readonly energyTarget?: Curve;
}

/** [07 §5] */
export interface Region {
  readonly startTick: number;
  readonly endTick: number;
  readonly tracks: readonly string[] | "all";
}

/** The selection (07 §5): one of four shapes. */
export type Selection =
  | { readonly kind: "none" }
  | { readonly kind: "sections"; readonly ids: readonly string[] }
  | { readonly kind: "tracks"; readonly ids: readonly string[] }
  | { readonly kind: "clips"; readonly ids: readonly string[] }
  | { readonly kind: "region"; readonly region: Region };

/** The zoom levels of 07 §2.1. */
export type ZoomLevel = "L2-far" | "L2" | "L2-near" | "L3";

/** The visible window of the time axis. */
export interface Viewport {
  /** Zoom, in CSS px per beat. */
  readonly pxPerBeat: number;
  /** The time at the left edge of the time area, in seconds. */
  readonly originSec: number;
}

/** What a gesture on a ribbon asks for; the app turns it into `track.update` ops. */
export interface TrackToggleEvent {
  readonly trackId: string;
  readonly field: "mute" | "solo";
  /** The new value. */
  readonly value: boolean;
}

/** Events out. */
export interface CanvasEvents {
  /** The user changed the selection by pointer on the canvas. */
  readonly selectionChange: Selection;
  /** The user asked to move the playhead (click on the ruler, in seconds). */
  readonly seek: { readonly sec: number };
  /** Solo or mute pressed on a ribbon. The renderer never changes the document itself. */
  readonly trackToggle: TrackToggleEvent;
  /** Pan or zoom changed, from a gesture or from `setViewport`. */
  readonly viewportChange: { readonly viewport: Viewport; readonly level: ZoomLevel };
  /** The pointer is over a ribbon (for `M`/`O` shortcuts), or left all of them. */
  readonly hoverTrack: { readonly trackId: string | null };
  /** The canvas wants a different height (lanes grow with the number of ribbons). */
  readonly contentHeight: { readonly px: number };
}

/** A handler map type helper. */
export type CanvasEventName = keyof CanvasEvents;
