/**
 * Synthesises the audio of the short demo song: four instruments, mono, 48 kHz, 16-bit WAV.
 *
 * Everything is maths, nothing is sampled: a drum pattern from sweeps and noise, a bass line,
 * pad chords and an arpeggio over A minor - F - C - G (i - VI - III - VII). It is deterministic,
 * so the same bytes (and the same content hash) come out every time, and it is original work
 * with no third-party audio (13 §1 rule 7, 10 §7).
 */
import { type DemoSpec, SAMPLE_RATE } from "./demo-song.js";

/** Root, third and fifth of the four chords, in Hz. */
const CHORDS: readonly (readonly [number, number, number])[] = [
  [110.0, 130.81, 164.81], // Am
  [87.31, 110.0, 130.81], // F
  [130.81, 164.81, 196.0], // C
  [98.0, 123.47, 146.83], // G
];

/** A small deterministic noise source. */
function noiseSource(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2147483648 - 1;
  };
}

/** Per-part loudness, so choruses lift (07 §2 "fill brightness by mean energy"). */
function partGain(kind: string): number {
  switch (kind) {
    case "chorus":
      return 1;
    case "verse":
      return 0.8;
    case "bridge":
      return 0.65;
    default:
      return 0.55;
  }
}

/** Renders one instrument over the whole song as floats in [-1, 1]. */
export function renderStem(spec: DemoSpec, stemKey: string): Float32Array {
  const secondsPerBeat = 60 / spec.bpm;
  const samplesPerBeat = secondsPerBeat * SAMPLE_RATE;
  const samplesPerBar = samplesPerBeat * spec.beatsPerBar;
  const totalBars = spec.sections.reduce((sum, section) => sum + section.bars, 0);
  const out = new Float32Array(Math.round(totalBars * samplesPerBar));
  const noise = noiseSource(0x9e3779b9 ^ stemKey.length);
  const twoPi = Math.PI * 2;

  let startBar = 0;
  for (const section of spec.sections) {
    const plays = section.plays.includes(stemKey);
    const gain = partGain(section.kind);
    for (let bar = 0; bar < section.bars; bar += 1) {
      const absoluteBar = startBar + bar;
      const chord = CHORDS[absoluteBar % CHORDS.length] as readonly [number, number, number];
      const barStart = Math.round(absoluteBar * samplesPerBar);
      const barEnd = Math.min(out.length, Math.round((absoluteBar + 1) * samplesPerBar));
      if (!plays) continue;
      for (let i = barStart; i < barEnd; i += 1) {
        const tBar = (i - barStart) / SAMPLE_RATE;
        const step = Math.floor((tBar / secondsPerBeat) * 4); // 16th note index in the bar
        const tStep = tBar - (step * secondsPerBeat) / 4;
        const tBeat = tBar - Math.floor(tBar / secondsPerBeat) * secondsPerBeat;
        let value = 0;
        switch (stemKey) {
          case "drums": {
            if (step % 8 === 0) {
              const sweep = 45 + 90 * Math.exp(-tBeat * 40);
              value += Math.sin(twoPi * sweep * tBeat) * Math.exp(-tBeat * 14) * 0.9;
            }
            if (step % 8 === 4) {
              value +=
                (noise() * 0.5 + Math.sin(twoPi * 190 * tStep) * 0.4) * Math.exp(-tStep * 22);
            }
            if (step % 2 === 0) value += noise() * 0.18 * Math.exp(-tStep * 90);
            break;
          }
          case "bass": {
            const eighth = Math.floor((tBar / secondsPerBeat) * 2);
            const tNote = tBar - (eighth * secondsPerBeat) / 2;
            const f = chord[0] / 2;
            const env = Math.exp(-tNote * 5) * 0.85 + 0.15;
            value +=
              (Math.sin(twoPi * f * tBar) + 0.35 * Math.sin(twoPi * f * 2 * tBar)) * env * 0.55;
            break;
          }
          case "pads": {
            const attack = Math.min(1, tBar / 0.4);
            const release = Math.min(1, (barEnd - i) / SAMPLE_RATE / 0.25);
            for (const f of chord) value += Math.sin(twoPi * f * 2 * tBar) * 0.14;
            value *= attack * release;
            break;
          }
          case "arp": {
            const eighth = Math.floor((tBar / secondsPerBeat) * 2);
            const tNote = tBar - (eighth * secondsPerBeat) / 2;
            const f = (chord[eighth % 3] as number) * 4;
            value += Math.sin(twoPi * f * tBar) * Math.exp(-tNote * 9) * 0.32;
            break;
          }
          default:
            break;
        }
        out[i] = Math.max(-1, Math.min(1, value * gain));
      }
    }
    startBar += section.bars;
  }
  return out;
}

/** Encodes mono floats as a 16-bit PCM WAV file. */
export function encodeWav16(samples: Float32Array, sampleRate = SAMPLE_RATE): Uint8Array {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(44 + index * 2, Math.round(clamped * 32767), true);
  }
  return new Uint8Array(buffer);
}
