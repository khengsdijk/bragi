/**
 * The content of the accessible grid (11 §6.1), as data.
 *
 * "Rows are 'Song layout' (sections) and one row per instrument. Columns are sections. Each cell
 * exposes the section name, bars, energy ('high energy'), and whether the instrument is playing
 * there. Chords are exposed per section as text."
 *
 * Built from the same {@link CanvasDocument} and {@link AnalysisView} the canvas draws, so the two
 * cannot drift; the acceptance test builds it from a document and checks it against the raw JSON.
 */
import { type AnalysisView, type CanvasDocument, meanOfCurve } from "@bragi/render-canvas";

import { type MessageKey, t } from "../../../i18n/index.js";

export type EnergyWord = "low" | "medium" | "high";

export interface GridColumn {
  readonly sectionId: string;
  readonly label: string;
  readonly bars: number;
  readonly locked: boolean;
  /** `null` until the energy stage has arrived. */
  readonly energy: EnergyWord | null;
  readonly chords: readonly string[];
}

export interface GridCell {
  readonly sectionId: string;
  readonly text: string;
  /** Instrument rows only: the instrument has audio in this part. */
  readonly playing?: boolean;
}

export type GridRowKind = "layout" | "chords" | "instrument";

export interface GridRow {
  readonly kind: GridRowKind;
  /** The track id for instrument rows, otherwise the row kind. */
  readonly id: string;
  readonly name: string;
  readonly mute: boolean;
  readonly solo: boolean;
  readonly cells: readonly GridCell[];
}

export interface GridModel {
  readonly columns: readonly GridColumn[];
  readonly rows: readonly GridRow[];
}

/** 0..1 energy to a word. */
export function energyWord(value: number): EnergyWord {
  if (value < 1 / 3) return "low";
  if (value < 2 / 3) return "medium";
  return "high";
}

function barsText(count: number): string {
  return t(count === 1 ? "song.grid.bars.one" : "song.grid.bars.other", { count });
}

/** The text a screen reader gets for a section: "Chorus 1, 8 bars, high energy". */
export function sectionText(column: GridColumn): string {
  const parts = [column.label, barsText(column.bars)];
  if (column.energy !== null) parts.push(t(`song.grid.energy.${column.energy}` as MessageKey));
  if (column.locked) parts.push(t("song.grid.locked"));
  return parts.join(", ");
}

/** Builds the grid for a document. */
export function buildGridModel(doc: CanvasDocument, analysis: AnalysisView | null): GridModel {
  const chordRows = analysis?.chords;
  const columns: GridColumn[] = doc.sections.map((section) => {
    const energy = analysis?.energy
      ? energyWord(meanOfCurve(analysis.energy, section.startSec, section.endSec))
      : null;
    const chords: string[] = [];
    if (chordRows) {
      for (const chord of chordRows) {
        // A chord belongs to the part it starts in.
        if (chord.startSec >= section.startSec && chord.startSec < section.endSec) {
          if (chords[chords.length - 1] !== chord.label) chords.push(chord.label);
        }
      }
    }
    return {
      sectionId: section.id,
      label: section.label,
      bars: section.bars,
      locked: section.locked,
      energy,
      chords,
    };
  });

  const playingIn = new Set(doc.clips.map((clip) => `${clip.trackId}|${clip.sectionId}`));
  const rows: GridRow[] = [
    {
      kind: "layout",
      id: "layout",
      name: t("song.grid.layoutRow"),
      mute: false,
      solo: false,
      cells: columns.map((column) => ({ sectionId: column.sectionId, text: sectionText(column) })),
    },
  ];
  if (chordRows) {
    rows.push({
      kind: "chords",
      id: "chords",
      name: t("song.grid.chordsRow"),
      mute: false,
      solo: false,
      cells: columns.map((column) => ({
        sectionId: column.sectionId,
        text:
          column.chords.length === 0
            ? t("song.grid.chordsPending")
            : t("song.grid.chords", { chords: column.chords.join(" ") }),
      })),
    });
  }
  for (const track of doc.tracks) {
    if (track.hidden) continue;
    rows.push({
      kind: "instrument",
      id: track.id,
      name: track.name,
      mute: track.mute,
      solo: track.solo,
      cells: columns.map((column) => {
        const playing = playingIn.has(`${track.id}|${column.sectionId}`);
        return {
          sectionId: column.sectionId,
          playing,
          text: t(playing ? "song.grid.playing" : "song.grid.silent", { name: track.name }),
        };
      }),
    });
  }
  return { columns, rows };
}
