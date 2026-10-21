"""The five synthetic fixture songs of the generation bench (09 §9 check 1).

Each fixture is a self-made, deterministic arrangement rendered in code at 48 kHz
stereo: no recording, no committed audio, nothing copyrighted (13 §1.7). They are
deliberately different — tempo, meter, key, instrumentation and groove — so a
generator is asked to continue five *different* songs rather than one pattern
transposed five times:

==========  =====  =====  ========  ==========================================
id          BPM    meter  key       arrangement
==========  =====  =====  ========  ==========================================
``pop``     120    4/4    A minor   kick/snare, eighth-note bass, detuned pad
``hiphop``  90     4/4    C minor   half-time backbeat, Rhodes 7th chords, sub
``house``   128    4/4    F# minor  four-on-the-floor, offbeat stabs, claps
``waltz``   75     3/4    G major   piano arpeggio, bass, string pad
``rock``    140    4/4    D major   saw power chords, rock backbeat, lead riff
==========  =====  =====  ========  ==========================================

Every random choice comes from a seeded ``numpy`` generator, so the same fixture
renders bit-identically on every run. The bench takes the last ~30 s of each song
on a bar line as the context; :meth:`Fixture.context_audio` is that slice.
"""

from __future__ import annotations

import fnmatch
import math
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal

import numpy as np
from numpy.typing import NDArray

from bragi_generate.postprocess.types import Audio, KeySpec

type F32 = NDArray[np.float32]
type Style = Literal["pop", "hiphop", "house", "waltz", "rock"]

#: The engine renders context at 48 kHz (02 §2), so fixtures speak it too.
SAMPLE_RATE = 48_000
#: The context length 09 §4.2 asks for, snapped to a bar line per fixture.
CONTEXT_TARGET_SEC = 30.0

#: Semitones of a chord quality above its root.
_QUALITY_INTERVALS: dict[str, tuple[int, ...]] = {
    "maj": (0, 4, 7),
    "min": (0, 3, 7),
    "maj7": (0, 4, 7, 11),
    "min7": (0, 3, 7, 10),
    "7": (0, 4, 7, 10),
}

#: One four-bar loop per style: ``(semitones above the tonic, quality)``.
_PROGRESSIONS: dict[Style, tuple[tuple[int, str], ...]] = {
    "pop": ((0, "min"), (8, "maj"), (3, "maj"), (10, "maj")),
    "hiphop": ((0, "min7"), (8, "maj7"), (3, "maj7"), (10, "7")),
    "house": ((0, "min"), (10, "maj"), (8, "maj"), (10, "maj")),
    "waltz": ((0, "maj"), (5, "maj"), (7, "maj"), (0, "maj")),
    "rock": ((0, "maj"), (7, "maj"), (9, "min"), (5, "maj")),
}


def midi_to_hz(midi: float) -> float:
    """Equal-tempered frequency of a MIDI note number."""
    return float(440.0 * 2.0 ** ((midi - 69.0) / 12.0))


def _root_midi(key: KeySpec, semitones: int, octave: int) -> int:
    """The MIDI root of a chord ``semitones`` above the tonic, in ``octave`` (3 = C3)."""
    return 48 + key.tonic_pc + semitones + 12 * octave


def _chord_midi(key: KeySpec, semitones: int, quality: str, octave: int) -> tuple[int, ...]:
    """MIDI notes of a chord, root in ``octave``."""
    root = _root_midi(key, semitones, octave)
    return tuple(root + interval for interval in _QUALITY_INTERVALS[quality])


def _envelope(length: int, rate: int, attack_sec: float, release_sec: float) -> F32:
    """A linear attack and release with a flat sustain between them."""
    t = np.arange(length, dtype=np.float64) / rate
    seconds = length / rate
    attack = np.clip(t / max(attack_sec, 1e-6), 0.0, 1.0)
    release = np.clip((seconds - t) / max(release_sec, 1e-6), 0.0, 1.0)
    return (attack * release).astype(np.float32)


def _tone(
    rate: int,
    frequency: float,
    seconds: float,
    *,
    partials: tuple[float, ...] = (1.0,),
    attack_sec: float = 0.004,
    decay: float = 0.0,
    release_sec: float = 0.03,
    detune_cents: float = 0.0,
) -> F32:
    """A harmonic tone with an exponential decay (plucks) or a flat sustain (pads)."""
    length = max(1, round(seconds * rate))
    t = np.arange(length, dtype=np.float64) / rate
    detuned = frequency * 2.0 ** (detune_cents / 1200.0)
    wave = np.zeros(length, dtype=np.float64)
    for index, amplitude in enumerate(partials):
        phase = 0.7 * index
        wave += amplitude * np.sin(2.0 * np.pi * detuned * (index + 1) * t + phase)
    gain = _envelope(length, rate, attack_sec, release_sec)
    if decay > 0.0:
        gain = gain * np.exp(-t * decay).astype(np.float32)
    return (wave * gain).astype(np.float32)


def _split(width_cents: float) -> tuple[float, float]:
    """Two detune offsets for a stereo pair."""
    return -width_cents, width_cents


def _add(target: F32, start: int, hit: F32, gain: float = 1.0) -> None:
    """Adds a mono hit at ``start`` into both channels, clipped to the buffer."""
    if start >= target.shape[0] or hit.size == 0:
        return
    begin = max(0, start)
    offset = begin - start
    end = min(target.shape[0], start + hit.shape[0])
    if end <= begin:
        return
    target[begin:end, 0] += hit[offset : offset + end - begin] * np.float32(gain)
    target[begin:end, 1] += hit[offset : offset + end - begin] * np.float32(gain)


def _add_stereo(target: F32, start: int, left: F32, right: F32) -> None:
    """Adds a stereo hit at ``start``, clipped to the buffer."""
    if start >= target.shape[0] or left.size == 0:
        return
    begin = max(0, start)
    offset = begin - start
    end = min(target.shape[0], start + left.shape[0])
    if end <= begin:
        return
    target[begin:end, 0] += left[offset : offset + end - begin]
    target[begin:end, 1] += right[offset : offset + end - begin]


def _kick(rate: int, *, length_sec: float = 0.18, decay: float = 16.0) -> F32:
    """A pitch-swept sine, the classic synthetic kick."""
    length = round(length_sec * rate)
    t = np.arange(length, dtype=np.float64) / rate
    frequency = 48.0 + 92.0 * np.exp(-t * 30.0)
    phase = 2.0 * np.pi * np.cumsum(frequency) / rate
    return np.asarray(np.sin(phase) * np.exp(-t * decay), dtype=np.float32)


def _snare(rate: int, rng: np.random.Generator) -> F32:
    """Noise plus a short body tone (a backbeat)."""
    length = round(0.16 * rate)
    t = np.arange(length, dtype=np.float64) / rate
    noise = rng.standard_normal(length)
    body = 0.6 * np.sin(2.0 * np.pi * 185.0 * t)
    return np.asarray((noise + body) * np.exp(-t * 28.0) * 0.6, dtype=np.float32)


def _hat(rate: int, rng: np.random.Generator, *, decay: float = 80.0) -> F32:
    """First-differenced noise: a cheap high-passed hat."""
    length = round(0.06 * rate)
    t = np.arange(length, dtype=np.float64) / rate
    noise = rng.standard_normal(length)
    high = np.diff(noise, prepend=0.0)
    return np.asarray(high * np.exp(-t * decay) * 0.5, dtype=np.float32)


def _clap(rate: int, rng: np.random.Generator) -> F32:
    """Three quick noise bursts, wider and slower than the snare."""
    length = round(0.2 * rate)
    t = np.arange(length, dtype=np.float64) / rate
    env = np.exp(-t * 22.0)
    env[: round(0.012 * rate)] *= 0.4
    return np.asarray(rng.standard_normal(length) * env * 0.35, dtype=np.float32)


def _normalise(samples: F32, peak: float = 0.85) -> F32:
    """Scales the whole arrangement to one peak, so fixtures share a loudness scale."""
    current = float(np.max(np.abs(samples)))
    if current <= 0.0:
        return samples
    return (samples * np.float32(peak / current)).astype(np.float32)


@dataclass(frozen=True)
class Fixture:
    """One synthetic song and the musical facts it was written with."""

    id: str
    title: str
    bpm: float
    time_signature: tuple[int, int]
    key: KeySpec
    bars: int
    style: Style
    descriptors: tuple[str, ...]

    def __post_init__(self) -> None:
        """Rejects a fixture too short to hold the context plus a bar of headroom."""
        if self.beats_per_bar < 1 or self.bars < 2:
            raise ValueError(f"{self.id}: need at least two bars")
        if self.duration_sec <= CONTEXT_TARGET_SEC:
            raise ValueError(
                f"{self.id}: must be longer than the {CONTEXT_TARGET_SEC:.0f} s context"
            )

    @property
    def beats_per_bar(self) -> int:
        """Beats in a bar, counted by the meter's numerator."""
        return self.time_signature[0]

    @property
    def beat_sec(self) -> float:
        """Length of one beat."""
        return 60.0 / self.bpm

    @property
    def bar_sec(self) -> float:
        """Length of one bar."""
        return self.beat_sec * self.beats_per_bar

    @property
    def duration_sec(self) -> float:
        """Length of the whole fixture."""
        return self.bar_sec * self.bars

    @property
    def key_label(self) -> str:
        """``"A minor"``, for the report."""
        return self.key.label

    @property
    def context_bars(self) -> int:
        """Bars of context: the count putting the end nearest 30 s (ties take longer)."""
        return max(1, math.floor(CONTEXT_TARGET_SEC / self.bar_sec + 0.5))

    @property
    def context_sec(self) -> float:
        """Length of the context slice."""
        return self.context_bars * self.bar_sec

    def render(self, rate: int = SAMPLE_RATE) -> Audio:
        """Renders the whole song deterministically."""
        renderer = _RENDERERS[self.style]
        return Audio(renderer(self, rate), rate)

    def context_audio(self, rate: int = SAMPLE_RATE) -> Audio:
        """The last ~30 s on a bar line: the song's tail, per 09 §4.2."""
        song = self.render(rate)
        start = round((self.bars - self.context_bars) * self.bar_sec * rate)
        return Audio(np.ascontiguousarray(song.samples[start:]), rate)


def _render_pop(fixture: Fixture, rate: int) -> F32:
    rng = np.random.default_rng(11)
    beat_sec, bar_sec = fixture.beat_sec, fixture.bar_sec
    out = np.zeros((round(fixture.duration_sec * rate), 2), dtype=np.float32)
    kick, snare, hat = _kick(rate), _snare(rate, rng), _hat(rate, rng)
    progression = _PROGRESSIONS[fixture.style]

    for bar in range(fixture.bars):
        semitones, quality = progression[bar % len(progression)]
        bar_start = round(bar * bar_sec * rate)
        # Detuned pad, one chord per bar.
        notes = _chord_midi(fixture.key, semitones, quality, octave=0)
        for midi in notes[:3]:
            frequency = midi_to_hz(midi + 12)
            left, right = _split(4.0)
            _add(
                out,
                bar_start,
                _tone(
                    rate, frequency, bar_sec, attack_sec=0.12, release_sec=0.15, detune_cents=left
                ),
                0.07,
            )
            _add(
                out,
                bar_start,
                _tone(
                    rate, frequency, bar_sec, attack_sec=0.12, release_sec=0.15, detune_cents=right
                ),
                0.07,
            )
        # Bass: root on every beat, an octave below the pad.
        root = midi_to_hz(_root_midi(fixture.key, semitones, octave=-1))
        for beat in range(fixture.beats_per_bar):
            _add(
                out,
                bar_start + round(beat * beat_sec * rate),
                _tone(
                    rate, root, beat_sec * 0.85, partials=(1.0, 0.3), attack_sec=0.003, decay=3.0
                ),
                0.2,
            )

    for beat in range(fixture.bars * fixture.beats_per_bar):
        in_bar = beat % fixture.beats_per_bar
        start = round(beat * beat_sec * rate)
        if in_bar in (0, 2):
            _add(out, start, kick, 0.45)
        if in_bar in (1, 3):
            _add(out, start, snare, 0.22)
        _add(out, start + round(0.5 * beat_sec * rate), hat, 0.07)
    return _normalise(out)


def _render_hiphop(fixture: Fixture, rate: int) -> F32:
    rng = np.random.default_rng(23)
    beat_sec, bar_sec = fixture.beat_sec, fixture.bar_sec
    out = np.zeros((round(fixture.duration_sec * rate), 2), dtype=np.float32)
    kick, snare, hat = _kick(rate, length_sec=0.25, decay=10.0), _snare(rate, rng), _hat(rate, rng)
    progression = _PROGRESSIONS[fixture.style]

    for bar in range(fixture.bars):
        semitones, quality = progression[bar % len(progression)]
        bar_start = round(bar * bar_sec * rate)
        # Rhodes 7th chord, held through the bar with a bell-like decay.
        notes = _chord_midi(fixture.key, semitones, quality, octave=0)
        for midi in notes:
            frequency = midi_to_hz(midi + 12)
            _add(
                out,
                bar_start,
                _tone(
                    rate,
                    frequency,
                    bar_sec * 0.95,
                    partials=(1.0, 0.28, 0.1),
                    attack_sec=0.008,
                    decay=1.6,
                    release_sec=0.08,
                    detune_cents=-3.0,
                ),
                0.05,
            )
            _add(
                out,
                bar_start,
                _tone(
                    rate,
                    frequency,
                    bar_sec * 0.95,
                    partials=(1.0, 0.28, 0.1),
                    attack_sec=0.008,
                    decay=1.6,
                    release_sec=0.08,
                    detune_cents=3.0,
                ),
                0.05,
            )
        # Sub bass: one long root per bar (C2 for C minor), with a pickup an octave up.
        root = midi_to_hz(_root_midi(fixture.key, semitones, octave=-1))
        _add(
            out,
            bar_start,
            _tone(rate, root, bar_sec * 0.8, partials=(1.0, 0.2), attack_sec=0.01, decay=0.9),
            0.32,
        )
        _add(
            out,
            bar_start + round(2.5 * beat_sec * rate),
            _tone(
                rate, root * 2.0, beat_sec * 0.5, partials=(1.0, 0.2), attack_sec=0.005, decay=3.0
            ),
            0.18,
        )

    for beat in range(fixture.bars * fixture.beats_per_bar):
        in_bar = beat % fixture.beats_per_bar
        start = round(beat * beat_sec * rate)
        if in_bar == 0:
            _add(out, start, kick, 0.5)
        if in_bar == 2:
            _add(out, start, kick, 0.38)
        if in_bar == 2:  # half-time backbeat: one snare in the middle of the bar
            _add(out, start, snare, 0.24)
        _add(out, start + round(0.5 * beat_sec * rate), hat, 0.06)
    return _normalise(out)


def _render_house(fixture: Fixture, rate: int) -> F32:
    rng = np.random.default_rng(37)
    beat_sec, bar_sec = fixture.beat_sec, fixture.bar_sec
    out = np.zeros((round(fixture.duration_sec * rate), 2), dtype=np.float32)
    kick = _kick(rate, length_sec=0.22, decay=12.0)
    hat = _hat(rate, rng, decay=30.0)
    clap = _clap(rate, rng)
    progression = _PROGRESSIONS[fixture.style]

    for bar in range(fixture.bars):
        semitones, quality = progression[bar % len(progression)]
        notes = _chord_midi(fixture.key, semitones, quality, octave=0)
        # Offbeat organ stab: short, bright, one per eighth-note off-beat.
        for beat in range(fixture.beats_per_bar):
            start = round((bar * bar_sec + (beat + 0.5) * beat_sec) * rate)
            for midi in notes:
                _add(
                    out,
                    start,
                    _tone(
                        rate,
                        midi_to_hz(midi + 12),
                        beat_sec * 0.28,
                        partials=(1.0, 0.5, 0.25),
                        attack_sec=0.004,
                        decay=14.0,
                        release_sec=0.02,
                    ),
                    0.05,
                )
            _add(out, start, hat, 0.09)
        # Offbeat bass under the stabs.
        root = midi_to_hz(_root_midi(fixture.key, semitones, octave=-1))
        for beat in range(fixture.beats_per_bar):
            start = round((bar * bar_sec + (beat + 0.5) * beat_sec) * rate)
            _add(
                out,
                start,
                _tone(
                    rate, root, beat_sec * 0.35, partials=(1.0, 0.4), attack_sec=0.004, decay=6.0
                ),
                0.22,
            )

    for beat in range(fixture.bars * fixture.beats_per_bar):
        in_bar = beat % fixture.beats_per_bar
        start = round(beat * beat_sec * rate)
        _add(out, start, kick, 0.5)
        if in_bar in (1, 3):
            _add(out, start, clap, 0.3)
    return _normalise(out)


def _render_waltz(fixture: Fixture, rate: int) -> F32:
    beat_sec, bar_sec = fixture.beat_sec, fixture.bar_sec
    out = np.zeros((round(fixture.duration_sec * rate), 2), dtype=np.float32)
    progression = _PROGRESSIONS[fixture.style]
    # Root, fifth, third, fifth, root (octave), fifth: a rolling 6/8-style arpeggio.
    arpeggio: tuple[int, ...] = (0, 7, 12, 7, 12, 7)
    offsets = (0.0, 0.5, 1.0, 1.5, 2.0, 2.5)

    for bar in range(fixture.bars):
        semitones, quality = progression[bar % len(progression)]
        bar_start = round(bar * bar_sec * rate)
        notes = _chord_midi(fixture.key, semitones, quality, octave=0)
        # Soft string pad under the piano.
        for midi in notes:
            _add(
                out,
                bar_start,
                _tone(
                    rate,
                    midi_to_hz(midi),
                    bar_sec,
                    partials=(1.0, 0.6, 0.3, 0.15),
                    attack_sec=0.25,
                    release_sec=0.3,
                    detune_cents=-5.0,
                ),
                0.035,
            )
            _add(
                out,
                bar_start,
                _tone(
                    rate,
                    midi_to_hz(midi),
                    bar_sec,
                    partials=(1.0, 0.6, 0.3, 0.15),
                    attack_sec=0.25,
                    release_sec=0.3,
                    detune_cents=5.0,
                ),
                0.035,
            )
        # Piano arpeggio: a plucked tone per eighth, walking up the chord.
        for index, offset in enumerate(offsets):
            interval = arpeggio[index % len(arpeggio)]
            midi = notes[0] + interval
            _add(
                out,
                bar_start + round(offset * beat_sec * rate),
                _tone(
                    rate,
                    midi_to_hz(midi + 12),
                    beat_sec * 0.9,
                    partials=(1.0, 0.45, 0.22, 0.1),
                    attack_sec=0.002,
                    decay=5.0,
                    release_sec=0.04,
                ),
                0.09,
            )
        # Bass: root on the downbeat, fifth on beat two (the waltz pulse).
        root = _root_midi(fixture.key, semitones, octave=-1)
        _add(
            out,
            bar_start,
            _tone(
                rate,
                midi_to_hz(root),
                beat_sec * 0.9,
                partials=(1.0, 0.35),
                attack_sec=0.006,
                decay=2.5,
            ),
            0.2,
        )
        _add(
            out,
            bar_start + round(beat_sec * rate),
            _tone(
                rate,
                midi_to_hz(root + 7),
                beat_sec * 0.8,
                partials=(1.0, 0.3),
                attack_sec=0.006,
                decay=3.0,
            ),
            0.14,
        )
    return _normalise(out)


def _render_rock(fixture: Fixture, rate: int) -> F32:
    rng = np.random.default_rng(53)
    beat_sec, bar_sec = fixture.beat_sec, fixture.bar_sec
    out = np.zeros((round(fixture.duration_sec * rate), 2), dtype=np.float32)
    kick, snare, hat = _kick(rate, decay=14.0), _snare(rate, rng), _hat(rate, rng, decay=60.0)
    progression = _PROGRESSIONS[fixture.style]
    # A diatonic riff for two bars: it spells out D major under the power chords.
    riff: tuple[int, ...] = (0, 4, 7, 4, 5, 4, 2, 0)

    for bar in range(fixture.bars):
        semitones, _quality = progression[bar % len(progression)]
        bar_start = round(bar * bar_sec * rate)
        root = _root_midi(fixture.key, semitones, octave=0)
        # Palm-muted saw power chord (root, fifth, octave) on every eighth.
        for eighth in range(fixture.beats_per_bar * 2):
            start = bar_start + round(eighth * 0.5 * beat_sec * rate)
            for interval in (0, 7, 12):
                frequency = midi_to_hz(root + interval)
                _add(
                    out,
                    start,
                    _tone(
                        rate,
                        frequency,
                        beat_sec * 0.42,
                        partials=(1.0, 0.5, 0.33, 0.25, 0.2),
                        attack_sec=0.004,
                        decay=9.0,
                        release_sec=0.02,
                    ),
                    0.055,
                )
        # Bass doubles the chord root.
        for eighth in range(fixture.beats_per_bar * 2):
            start = bar_start + round(eighth * 0.5 * beat_sec * rate)
            _add(
                out,
                start,
                _tone(
                    rate,
                    midi_to_hz(root - 12),
                    beat_sec * 0.4,
                    partials=(1.0, 0.35),
                    attack_sec=0.004,
                    decay=7.0,
                ),
                0.18,
            )
        # Lead riff on the odd bars, an octave above the guitar.
        if bar % 2 == 0:
            for step in range(4):
                midi = fixture.key.tonic_pc + 48 + 12 + riff[step]
                start = bar_start + round(step * beat_sec * rate)
                _add(
                    out,
                    start,
                    _tone(
                        rate,
                        midi_to_hz(midi),
                        beat_sec * 0.8,
                        partials=(1.0, 0.4, 0.2),
                        attack_sec=0.005,
                        decay=4.0,
                    ),
                    0.07,
                )
        else:
            for step in range(4):
                midi = fixture.key.tonic_pc + 48 + 12 + riff[step + 4]
                start = bar_start + round(step * beat_sec * rate)
                _add(
                    out,
                    start,
                    _tone(
                        rate,
                        midi_to_hz(midi),
                        beat_sec * 0.8,
                        partials=(1.0, 0.4, 0.2),
                        attack_sec=0.005,
                        decay=4.0,
                    ),
                    0.07,
                )

    for beat in range(fixture.bars * fixture.beats_per_bar):
        in_bar = beat % fixture.beats_per_bar
        start = round(beat * beat_sec * rate)
        if in_bar in (0, 2):
            _add(out, start, kick, 0.48)
        if in_bar == 2:
            _add(out, start + round(0.5 * beat_sec * rate), kick, 0.3)
        if in_bar in (1, 3):
            _add(out, start, snare, 0.24)
        _add(out, start, hat, 0.05)
        _add(out, start + round(0.5 * beat_sec * rate), hat, 0.04)
    return _normalise(out)


_RENDERERS: dict[Style, Callable[[Fixture, int], F32]] = {
    "pop": _render_pop,
    "hiphop": _render_hiphop,
    "house": _render_house,
    "waltz": _render_waltz,
    "rock": _render_rock,
}

#: The five fixtures of 09 §9 check 1, in report order.
FIXTURES: tuple[Fixture, ...] = (
    Fixture(
        id="pop",
        title="A-minor pop groove",
        bpm=120.0,
        time_signature=(4, 4),
        key=KeySpec.parse("A", "minor"),
        bars=32,
        style="pop",
        descriptors=("warm analog pop", "drums, bass and pads", "uplifting"),
    ),
    Fixture(
        id="hiphop",
        title="C-minor half-time hip-hop",
        bpm=90.0,
        time_signature=(4, 4),
        key=KeySpec.parse("C", "minor"),
        bars=24,
        style="hiphop",
        descriptors=("lo-fi hip-hop", "dusty Rhodes chords", "half-time drums", "laid-back"),
    ),
    Fixture(
        id="house",
        title="F#-minor deep house",
        bpm=128.0,
        time_signature=(4, 4),
        key=KeySpec.parse("F#", "minor"),
        bars=34,
        style="house",
        descriptors=("deep house", "four-on-the-floor", "filtered chord stabs", "club"),
    ),
    Fixture(
        id="waltz",
        title="G-major waltz",
        bpm=75.0,
        time_signature=(3, 4),
        key=KeySpec.parse("G", "major"),
        bars=26,
        style="waltz",
        descriptors=("slow waltz", "solo piano arpeggio", "warm strings", "3/4 time"),
    ),
    Fixture(
        id="rock",
        title="D-major rock pattern",
        bpm=140.0,
        time_signature=(4, 4),
        key=KeySpec.parse("D", "major"),
        bars=36,
        style="rock",
        descriptors=("garage rock", "saw power chords", "driving drums"),
    ),
)

FIXTURE_IDS: tuple[str, ...] = tuple(fixture.id for fixture in FIXTURES)


def by_id(fixture_id: str) -> Fixture:
    """The fixture with that id.

    Raises:
        KeyError: when no fixture has it.
    """
    for fixture in FIXTURES:
        if fixture.id == fixture_id:
            return fixture
    raise KeyError(f"unknown fixture {fixture_id!r} (known: {', '.join(FIXTURE_IDS)})")


def select(spec: str | None) -> tuple[Fixture, ...]:
    """The fixtures a comma-separated ``id``/glob ``spec`` selects (all when empty)."""
    if spec is None or spec.strip() == "":
        return FIXTURES
    patterns = [pattern.strip() for pattern in spec.split(",") if pattern.strip()]
    if not patterns:
        return FIXTURES
    selected = tuple(
        fixture
        for fixture in FIXTURES
        if any(fnmatch.fnmatchcase(fixture.id, pattern) for pattern in patterns)
    )
    if not selected:
        raise KeyError(f"no fixture matches {spec!r} (known: {', '.join(FIXTURE_IDS)})")
    return selected


__all__ = [
    "CONTEXT_TARGET_SEC",
    "FIXTURES",
    "FIXTURE_IDS",
    "SAMPLE_RATE",
    "Fixture",
    "Style",
    "by_id",
    "midi_to_hz",
    "select",
]
