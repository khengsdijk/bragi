#!/usr/bin/env node
/**
 * A deterministic, royalty-free 4-minute song for the M1 upload flow
 * (specs/13 §1.7: fixtures are self-made or generated; no recording).
 *
 * The output is a 48 kHz, 16-bit stereo WAV built from a few synthesised
 * voices — kick, snare, hat, bass, a chord pad and a lead — over an
 * intro/verse/chorus/bridge/chorus/outro form. Every random choice comes from a
 * seeded PRNG, so two runs produce byte-identical files (the integration test
 * and the Playwright upload flow can share one generator).
 *
 * It is deliberately **not** committed: 4 minutes of 48 kHz stereo is ~46 MB.
 * Run it when a live stack is available:
 *
 *   node scripts/fixture-song.mjs /tmp/bragi-4min.wav
 *
 * The default duration is 240 s; `--seconds` and `--rate` exist for a quick
 * smoke test.
 */
import { writeFileSync } from "node:fs";

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const BPM = 120;
const BEATS_PER_BAR = 4;

/**
 * A tiny deterministic PRNG (mulberry32); no `Math.random` anywhere.
 *
 * @param {number} seed
 * @returns {() => number}
 */
function prng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** @typedef {{ root: number, third: number, fifth: number }} Chord */
/** @typedef {{ kind: string, startBar: number, bars: number }} Section */

/** A-minor progression the pad and bass follow: Am, F, C, G. */
/** @type {readonly Chord[]} */
const CHORDS = [
  { root: 57, third: 60, fifth: 64 }, // A C E (A minor)
  { root: 53, third: 57, fifth: 60 }, // F A C (F major)
  { root: 48, third: 52, fifth: 55 }, // C E G (C major)
  { root: 55, third: 59, fifth: 62 }, // G B D (G major)
];
/** @type {Chord} */
const DEFAULT_CHORD = { root: 57, third: 60, fifth: 64 };

const KINDS = ["intro", "verse", "chorus", "verse", "chorus", "bridge", "chorus", "outro"];
/** @type {Readonly<Record<string, number>>} */
const DYNAMICS = { intro: 0.45, verse: 0.7, chorus: 1, bridge: 0.6, outro: 0.4 };
/** @type {Readonly<Record<string, readonly string[]>>} */
const PLAYS = {
  intro: ["pad"],
  verse: ["kick", "hat", "bass", "pad"],
  chorus: ["kick", "snare", "hat", "bass", "pad", "lead"],
  bridge: ["pad", "lead"],
  outro: ["pad"],
};
/** @type {Section} */
const DEFAULT_SECTION = { kind: "verse", startBar: 0, bars: 0 };

/**
 * Hz of a MIDI note.
 *
 * @param {number} note
 * @returns {number}
 */
const hz = (note) => 440 * 2 ** ((note - 69) / 12);

/**
 * The section plan for `bars`, repeating every eight bars within a kind.
 *
 * @param {number} bars
 * @returns {Section[]}
 */
function plan(bars) {
  /** @type {Section[]} */
  const sections = [];
  let bar = 0;
  let index = 0;
  while (bar < bars) {
    const kind = KINDS[index % KINDS.length] ?? "verse";
    const length = Math.min(kind === "intro" || kind === "outro" ? 4 : 8, bars - bar);
    sections.push({ kind, startBar: bar, bars: length });
    bar += length;
    index += 1;
  }
  return sections;
}

/**
 * Renders the fixture.
 *
 * @param {{ seconds?: number, sampleRate?: number }} [options]
 * @returns {{ buffer: Buffer, sampleRate: number, channels: number, seconds: number }}
 */
export function renderFixture(options = {}) {
  const sampleRate = options.sampleRate ?? SAMPLE_RATE;
  const seconds = options.seconds ?? 240;
  const totalSamples = Math.round(seconds * sampleRate);
  const secondsPerBeat = 60 / BPM;
  const secondsPerBar = secondsPerBeat * BEATS_PER_BAR;
  const totalBars = Math.ceil(seconds / secondsPerBar);
  const sections = plan(totalBars);

  const left = new Float32Array(totalSamples);
  const right = new Float32Array(totalSamples);
  const noise = prng(0x5eed1234);

  /**
   * @param {number} bar
   * @returns {Section}
   */
  const sectionAt = (bar) =>
    sections.find((section) => bar >= section.startBar && bar < section.startBar + section.bars) ??
    sections[sections.length - 1] ??
    DEFAULT_SECTION;

  for (let sample = 0; sample < totalSamples; sample += 1) {
    const t = sample / sampleRate;
    const beat = t / secondsPerBeat;
    const bar = Math.floor(beat / BEATS_PER_BAR);
    const beatInBar = beat % BEATS_PER_BAR;
    const section = sectionAt(bar);
    const gain = DYNAMICS[section.kind] ?? 0.6;
    const plays = PLAYS[section.kind] ?? [];
    const chord = CHORDS[bar % CHORDS.length] ?? DEFAULT_CHORD;
    let mix = 0;

    if (plays.includes("kick")) {
      const phase = beat % 1;
      const env = Math.exp(-phase * 18);
      mix += Math.sin(2 * Math.PI * 55 * t) * env * 0.9;
    }
    if (plays.includes("snare") && beatInBar % 2 >= 1) {
      const phase = beat % 1;
      const env = Math.exp(-phase * 22);
      mix += (noise() * 2 - 1) * env * 0.35;
    }
    if (plays.includes("hat")) {
      const phase = (beat * 2) % 1;
      const env = Math.exp(-phase * 40);
      mix += (noise() * 2 - 1) * env * 0.08;
    }
    if (plays.includes("bass")) {
      const phase = (beat % 1) * secondsPerBeat;
      const env = 0.5 + 0.5 * Math.exp(-phase * 4);
      mix += Math.sin(2 * Math.PI * hz(chord.root - 12) * t) * env * 0.28;
    }
    if (plays.includes("pad")) {
      const swell = 0.55 + 0.45 * Math.sin((bar / 4) * Math.PI);
      for (const note of [chord.root, chord.third, chord.fifth]) {
        mix += Math.sin(2 * Math.PI * hz(note) * t) * swell * 0.06;
      }
    }
    if (plays.includes("lead")) {
      // A pentatonic arpeggio on the chord tones, one note per half beat.
      const step = Math.floor(beat * 2) % 3;
      const note = [chord.root + 12, chord.third + 12, chord.fifth + 12][step] ?? chord.root + 12;
      const phase = (beat * 2) % 1;
      const env = Math.exp(-phase * 6);
      mix += Math.sin(2 * Math.PI * hz(note) * t) * env * 0.12;
    }

    const value = Math.max(-1, Math.min(1, mix * gain * 0.8));
    left[sample] = value;
    right[sample] = value;
  }

  return {
    buffer: encodeWav16(left, right, sampleRate),
    sampleRate,
    channels: CHANNELS,
    seconds,
  };
}

/**
 * Interleaves two float channels into a 16-bit PCM WAV.
 *
 * @param {Float32Array} left
 * @param {Float32Array} right
 * @param {number} sampleRate
 * @returns {Buffer}
 */
export function encodeWav16(left, right, sampleRate) {
  const frames = left.length;
  const dataBytes = frames * CHANNELS * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(CHANNELS, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * CHANNELS * 2, 28);
  buffer.writeUInt16LE(CHANNELS * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataBytes, 40);
  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    for (const channel of [left, right]) {
      const value = Math.max(-1, Math.min(1, channel[frame] ?? 0));
      buffer.writeInt16LE(Math.round(value * 32_767), offset);
      offset += 2;
    }
  }
  return buffer;
}

/**
 * @param {string[]} argv
 * @returns {void}
 */
function main(argv) {
  const output = argv.find((arg) => !arg.startsWith("--"));
  if (output === undefined) {
    process.stderr.write(
      "usage: node scripts/fixture-song.mjs <out.wav> [--seconds N] [--rate N]\n",
    );
    process.exitCode = 1;
    return;
  }
  /**
   * @param {string} name
   * @param {number} fallback
   * @returns {number}
   */
  const option = (name, fallback) => {
    const index = argv.indexOf(`--${name}`);
    const value = index < 0 ? Number.NaN : Number(argv[index + 1]);
    return Number.isFinite(value) ? value : fallback;
  };
  const { buffer, seconds, sampleRate } = renderFixture({
    seconds: option("seconds", 240),
    sampleRate: option("rate", SAMPLE_RATE),
  });
  writeFileSync(output, buffer);
  process.stdout.write(
    `${output}: ${seconds}s, ${sampleRate} Hz, ${CHANNELS} ch, ${buffer.length} bytes\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
