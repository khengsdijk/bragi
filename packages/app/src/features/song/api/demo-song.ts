/**
 * Generated demo songs (13 §6: fixtures are self-made, never copyrighted).
 *
 * The song document and its audio are both *generated*: nothing here is a recording. Two shapes:
 *
 * - {@link SHORT_DEMO}: 16 bars, four synthesised instruments (`demo-audio.ts`), small enough to
 *   put in the blob cache and play through the real engine.
 * - {@link benchmarkSpec}: a 10-minute song with 12 instruments and no audio, which is the
 *   07 §9 performance fixture (the canvas needs a document and analysis data, not samples).
 *
 * The documents are valid `Project` JSON (`packages/schemas/song/project.schema.json`) and are
 * loaded through `bragi-model` like any other.
 */

import type { SectionKind, StageStatus, StemRole } from "@bragi/render-canvas";
import type { AssetMeta, Project } from "@bragi/schemas";

export const PPQ = 960;
export const SAMPLE_RATE = 48000;

export interface DemoStem {
  readonly key: string;
  readonly name: string;
  readonly role: StemRole;
}

export interface DemoSection {
  readonly kind: SectionKind;
  readonly label: string;
  readonly bars: number;
  /** Keys of the stems that play in this part. */
  readonly plays: readonly string[];
}

export interface DemoSpec {
  readonly title: string;
  readonly bpm: number;
  readonly beatsPerBar: number;
  readonly stems: readonly DemoStem[];
  readonly sections: readonly DemoSection[];
}

/** The four generated instruments of the short demo. */
export const SHORT_STEMS: readonly DemoStem[] = [
  { key: "drums", name: "Drums", role: "drums" },
  { key: "bass", name: "Bass", role: "bass" },
  { key: "pads", name: "Pads", role: "synth" },
  { key: "arp", name: "Arpeggio", role: "piano" },
];

export const SHORT_DEMO: DemoSpec = {
  title: "Demo song",
  bpm: 120,
  beatsPerBar: 4,
  stems: SHORT_STEMS,
  sections: [
    { kind: "intro", label: "Intro", bars: 2, plays: ["pads", "arp"] },
    { kind: "verse", label: "Verse 1", bars: 4, plays: ["drums", "bass", "pads"] },
    { kind: "chorus", label: "Chorus 1", bars: 4, plays: ["drums", "bass", "pads", "arp"] },
    { kind: "bridge", label: "Bridge", bars: 2, plays: ["pads", "arp"] },
    { kind: "chorus", label: "Chorus 2", bars: 4, plays: ["drums", "bass", "pads", "arp"] },
  ],
};

const BENCH_STEMS: readonly DemoStem[] = [
  { key: "drums", name: "Drums", role: "drums" },
  { key: "bass", name: "Bass", role: "bass" },
  { key: "guitar", name: "Guitar", role: "guitar" },
  { key: "keys", name: "Keys", role: "piano" },
  { key: "lead", name: "Lead", role: "synth" },
  { key: "strings", name: "Strings", role: "strings" },
  { key: "vocals", name: "Vocals", role: "vocals" },
  { key: "perc", name: "Percussion", role: "drums" },
  { key: "pads", name: "Pads", role: "synth" },
  { key: "arp", name: "Arpeggio", role: "piano" },
  { key: "bells", name: "Bells", role: "generated" },
  { key: "fx", name: "Effects", role: "fx" },
];

const BENCH_KINDS: readonly { kind: SectionKind; label: string }[] = [
  { kind: "intro", label: "Intro" },
  { kind: "verse", label: "Verse" },
  { kind: "pre_chorus", label: "Pre-chorus" },
  { kind: "chorus", label: "Chorus" },
  { kind: "verse", label: "Verse" },
  { kind: "chorus", label: "Chorus" },
  { kind: "bridge", label: "Bridge" },
  { kind: "build", label: "Build" },
  { kind: "drop", label: "Drop" },
  { kind: "breakdown", label: "Breakdown" },
  { kind: "chorus", label: "Chorus" },
  { kind: "outro", label: "Outro" },
];

/**
 * A long, dense song for the performance budget (07 §9): `minutes` of 8-bar parts at 120 BPM
 * with `tracks` instruments (at most 12 distinct names; more repeat with a number).
 */
export function benchmarkSpec(minutes = 10, tracks = 12): DemoSpec {
  const stems = Array.from({ length: tracks }, (_, index): DemoStem => {
    const base = BENCH_STEMS[index % BENCH_STEMS.length] as DemoStem;
    return index < BENCH_STEMS.length
      ? base
      : { ...base, key: `${base.key}${index}`, name: `${base.name} ${Math.floor(index / 12) + 1}` };
  });
  const totalBars = Math.round((minutes * 60) / 2);
  const sections: DemoSection[] = [];
  let bars = 0;
  let index = 0;
  const counts = new Map<string, number>();
  while (bars < totalBars) {
    const shape = BENCH_KINDS[index % BENCH_KINDS.length] as { kind: SectionKind; label: string };
    const length = Math.min(8, totalBars - bars);
    const n = (counts.get(shape.label) ?? 0) + 1;
    counts.set(shape.label, n);
    // Parts differ in how many instruments play, like a real arrangement.
    const density = shape.kind === "intro" || shape.kind === "outro" ? 0.4 : 0.9;
    const plays = stems
      .filter((_, stemIndex) => (stemIndex * 7 + index * 3) % 10 < density * 10)
      .map((stem) => stem.key);
    sections.push({ kind: shape.kind, label: `${shape.label} ${n}`, bars: length, plays });
    bars += length;
    index += 1;
  }
  return { title: "Benchmark song", bpm: 120, beatsPerBar: 4, stems, sections };
}

/**
 * The song as it looks when only some analysis stages have arrived (07 §8): before `structure`
 * the arrangement is one "Song" block, and before `separation` there is one full-mix ribbon.
 * The result is what a document contains after the matching `analysis.apply` ops (02 §6.1).
 */
export function progressiveSpec(spec: DemoSpec, done: ReadonlySet<string>): DemoSpec {
  const separated = done.has("separation");
  const structured = done.has("structure");
  if (separated && structured) return spec;
  const mix: DemoStem = { key: "mix", name: "Full song", role: "full_mix" };
  const stems = separated ? spec.stems : [mix];
  const totalBars = spec.sections.reduce((sum, section) => sum + section.bars, 0);
  const everyone = stems.map((stem) => stem.key);
  const sections: readonly DemoSection[] = structured
    ? spec.sections.map((section) => ({ ...section, plays: separated ? section.plays : everyone }))
    : [{ kind: "custom", label: "Song", bars: totalBars, plays: everyone }];
  return { ...spec, stems, sections };
}

/** `sha256:` + 64 hex characters derived from a label (a stand-in for audio that does not exist). */
export function fakeAssetHash(seed: string): `sha256:${string}` {
  let hex = "";
  let state = 0x811c9dc5;
  for (let index = 0; hex.length < 64; index += 1) {
    const code = seed.charCodeAt(index % seed.length) + index;
    state = Math.imul(state ^ code, 0x01000193) >>> 0;
    hex += state.toString(16).padStart(8, "0");
  }
  return `sha256:${hex.slice(0, 64)}`;
}

export interface BuiltDemo {
  readonly project: Project;
  readonly assets: readonly AssetMeta[];
  readonly totalSamples: number;
  readonly durationSec: number;
}

const ALL_DONE: Readonly<Record<string, StageStatus>> = {
  ingest: "done",
  rhythm: "done",
  loudness_energy: "done",
  structure: "done",
  separation: "done",
  harmony: "done",
  tag: "done",
  describe: "done",
};

export interface BuildOptions {
  /** One asset hash per stem key. */
  readonly assetFor: (stemKey: string) => `sha256:${string}`;
  /** A stable project id suffix. */
  readonly projectId?: string;
  /** The recorded analysis stages; defaults to all done. */
  readonly stages?: Readonly<Record<string, StageStatus>>;
  readonly bytesPerAsset?: number;
}

/** Builds the song document, plus the asset metadata `bragi-model` validates clips against. */
export function buildDemoProject(spec: DemoSpec, options: BuildOptions): BuiltDemo {
  const barTicks = PPQ * spec.beatsPerBar;
  const barSamples = Math.round((SAMPLE_RATE * 60 * spec.beatsPerBar) / spec.bpm);
  const totalBars = spec.sections.reduce((sum, section) => sum + section.bars, 0);
  const totalSamples = totalBars * barSamples;
  const createdAt = "2026-10-19T09:00:00Z";
  const sourceId = "src_demo";
  const stemKeyToTrack = new Map(spec.stems.map((stem) => [stem.key, `trk_${stem.key}`]));

  let startBar = 0;
  const sections = spec.sections.map((section, index) => {
    const lanes: Record<string, { clips: unknown[]; automation: unknown[] }> = {};
    for (const stemKey of section.plays) {
      const trackId = stemKeyToTrack.get(stemKey);
      if (!trackId) continue;
      lanes[trackId] = {
        clips: [
          {
            id: `clp_s${index}x${stemKey}`,
            asset: options.assetFor(stemKey),
            srcStart: startBar * barSamples,
            srcEnd: (startBar + section.bars) * barSamples,
            start: 0,
            warp: { mode: "none" },
            gainDb: 0,
            pitchSemitones: 0,
            fadeInTicks: 0,
            fadeOutTicks: 0,
            fadeCurve: "equal_power",
            provenance: { kind: "generation", model: "bragi-demo-synth", createdAt },
          },
        ],
        automation: [],
      };
    }
    startBar += section.bars;
    return {
      id: `sec_${String(index).padStart(3, "0")}`,
      kind: section.kind,
      label: section.label,
      lengthTicks: section.bars * barTicks,
      lanes,
      transitionIn: { kind: "cut", lengthTicks: 0 },
    };
  });

  const stages = options.stages ?? ALL_DONE;
  const project = {
    schemaVersion: 1,
    id: `prj_${options.projectId ?? "DEMO"}`,
    meta: { title: spec.title, createdAt, tags: ["demo", "generated"] },
    sources: [
      {
        id: sourceId,
        kind: "generated",
        originalAsset: options.assetFor(spec.stems[0]?.key ?? "mix"),
        workingAsset: options.assetFor(spec.stems[0]?.key ?? "mix"),
        durationSamples: totalSamples,
        channels: 1,
        label: "Generated demo",
      },
    ],
    analyses: {
      [sourceId]: {
        profile: "standard",
        status: stages,
        blobs: {},
        summary: {
          bpm: spec.bpm,
          key: "A minor",
          durationSec: totalSamples / SAMPLE_RATE,
          genres: ["demo"],
          moods: ["calm"],
        },
      },
    },
    tracks: spec.stems.map((stem) => ({
      id: `trk_${stem.key}`,
      name: stem.name,
      role: stem.role,
      color: "#808693",
      gainDb: 0,
      pan: 0,
      mute: false,
      solo: false,
      hidden: false,
      fx: [],
    })),
    arrangement: {
      timebase: {
        ppq: PPQ,
        tempoMap: [{ tick: 0, bpm: spec.bpm, curve: "step" }],
        timeSignatures: [{ bar: 0, numerator: spec.beatsPerBar, denominator: 4 }],
      },
      sections,
      master: { fx: [], automation: [], gainDb: 0 },
    },
  } as unknown as Project;

  const assets: AssetMeta[] = spec.stems.map((stem) => ({
    hash: options.assetFor(stem.key),
    mime: "audio/wav",
    bytes: options.bytesPerAsset ?? totalSamples * 2 + 44,
    sampleRate: SAMPLE_RATE,
    channels: 1,
    durationSamples: totalSamples,
  }));
  return { project, assets, totalSamples, durationSec: totalSamples / SAMPLE_RATE };
}
