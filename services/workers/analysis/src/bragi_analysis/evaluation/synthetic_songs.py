"""Synthetic songs with a known section plan (WP-1.4).

Each section kind is a *recipe*: a chord loop, a timbre, a drum pattern and a level. A
song is a list of kinds, rendered bar by bar, so two sections of the same kind are
sample-identical (a true repetition) and sections of different kinds differ in harmony,
timbre, rhythm and loudness. The ground truth (boundaries, kinds, beats, downbeats) is exact.

This proves the structure *machinery* (metrics, snapping, grouping, wiring). It does not say
how the segmenter performs on real music, and a number measured here is never an eval gate
(04 section 8). Nothing is checked in: the audio is generated on the fly (13 section 1.7).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

type F32 = NDArray[np.float32]
type F64 = NDArray[np.float64]

SAMPLE_RATE = 22_050
BEATS_PER_BAR = 4

# Chord roots as semitones above A2 (110 Hz) with a minor/major flag.
_AM, _F, _C, _G, _DM, _EM = (0, "m"), (-4, ""), (3, ""), (-2, ""), (-7, "m"), (-5, "m")


@dataclass(frozen=True)
class Recipe:
    """How one section kind sounds."""

    chords: tuple[tuple[int, str], ...]
    #: Harmonic amplitudes of the voice (a bright voice has many).
    harmonics: tuple[float, ...]
    #: Octave shifts of the chord tones (an octave doubling widens the sound).
    octaves: tuple[int, ...]
    level: float
    kick_beats: tuple[int, ...]
    snare_beats: tuple[int, ...]
    hat_eighths: bool
    #: Notes re-struck every beat (plucked) or held for the whole bar (pad).
    plucked: bool


RECIPES: dict[str, Recipe] = {
    "intro": Recipe((_AM,), (1.0, 0.2), (0,), 0.30, (), (), False, False),
    "verse": Recipe((_AM, _F, _C, _G), (1.0, 0.5, 0.25), (0, 1), 0.50, (0, 2), (), False, True),
    "chorus": Recipe(
        (_F, _C, _G, _AM),
        (1.0, 0.8, 0.6, 0.5, 0.4),
        (-1, 0, 1),
        0.85,
        (0, 1, 2, 3),
        (1, 3),
        True,
        True,
    ),
    "bridge": Recipe(
        (_DM, _EM, _F, _G), (1.0, 0.0, 0.5, 0.0, 0.3), (0, 1), 0.55, (0,), (1, 3), False, False
    ),
    "outro": Recipe((_F,), (1.0, 0.6, 0.0, 0.4), (0, 1), 0.25, (), (), False, False),
}

#: The section kinds the generator knows (all are `SectionKind` values).
KINDS = tuple(RECIPES)


@dataclass(frozen=True)
class Section:
    """Ground truth for one section."""

    startSec: float  # noqa: N815 - mirrors the schema field names
    endSec: float  # noqa: N815
    kind: str


@dataclass(frozen=True)
class SyntheticSong:
    """Audio plus its exact section plan and beat grid."""

    name: str
    audio: F32
    sample_rate: int
    sections: list[Section]
    beats: F64
    downbeats: F64


def _chord_freqs(chord: tuple[int, str], octaves: tuple[int, ...]) -> list[float]:
    root, quality = chord
    third = 3 if quality == "m" else 4
    semis = [root, root + third, root + 7]
    return [110.0 * 2.0 ** ((s + 12 * o) / 12.0) for s in semis for o in octaves]


def _voice(freqs: list[float], harmonics: tuple[float, ...], seconds: float, plucked: bool) -> F32:
    n = round(seconds * SAMPLE_RATE)
    t = np.arange(n) / SAMPLE_RATE
    out = np.zeros(n)
    for f in freqs:
        for h, amp in enumerate(harmonics, start=1):
            if amp > 0 and f * h < SAMPLE_RATE / 2 - 500:
                out += amp * np.sin(2 * np.pi * f * h * t)
    if plucked:
        env = np.exp(-t / 0.35)
    else:
        env = np.minimum(1.0, t / 0.05) * np.minimum(1.0, (seconds - t) / 0.05)
    return (out * env / max(len(freqs), 1)).astype(np.float32)


def _drum(kind: str, seed: int) -> F32:
    rng = np.random.default_rng(seed)
    n = int(0.15 * SAMPLE_RATE)
    t = np.arange(n) / SAMPLE_RATE
    if kind == "kick":
        return (np.sin(2 * np.pi * 55 * t) * np.exp(-t / 0.05)).astype(np.float32)
    if kind == "snare":
        return (rng.uniform(-1, 1, n) * np.exp(-t / 0.04)).astype(np.float32)
    return (rng.uniform(-1, 1, n) * np.exp(-t / 0.01) * 0.3).astype(np.float32)


def render_bar(kind: str, bar_in_section: int, bpm: float) -> F32:
    """One bar of ``kind`` (plus a short tail); deterministic in its arguments."""
    recipe = RECIPES[kind]
    beat_sec = 60.0 / bpm
    bar = np.zeros(round(BEATS_PER_BAR * beat_sec * SAMPLE_RATE) + SAMPLE_RATE // 2, np.float32)
    chord = recipe.chords[bar_in_section % len(recipe.chords)]
    freqs = _chord_freqs(chord, recipe.octaves)
    if recipe.plucked:
        for beat in range(BEATS_PER_BAR):
            tone = _voice(freqs, recipe.harmonics, beat_sec * 1.5, True)
            start = round(beat * beat_sec * SAMPLE_RATE)
            bar[start : start + tone.size] += tone[: bar.size - start]
    else:
        tone = _voice(freqs, recipe.harmonics, BEATS_PER_BAR * beat_sec, False)
        bar[: tone.size] += tone
    kick, snare, hat = _drum("kick", 1), _drum("snare", 2), _drum("hat", 3)
    for beat in recipe.kick_beats:
        s = round(beat * beat_sec * SAMPLE_RATE)
        bar[s : s + kick.size] += 0.9 * kick
    for beat in recipe.snare_beats:
        s = round(beat * beat_sec * SAMPLE_RATE)
        bar[s : s + snare.size] += 0.6 * snare
    if recipe.hat_eighths:
        for eighth in range(BEATS_PER_BAR * 2):
            s = round(eighth * beat_sec / 2 * SAMPLE_RATE)
            bar[s : s + hat.size] += hat
    return bar * recipe.level


def render_song(
    name: str,
    plan: list[tuple[str, int]],
    bpm: float = 120.0,
    *,
    lead_in_sec: float = 0.0,
    noise_db: float | None = None,
) -> SyntheticSong:
    """Renders ``plan`` = ``[(kind, bars), ...]``.

    The first downbeat sits at ``lead_in_sec`` (silent before it); boundaries are at downbeats.
    """
    bar_sec = BEATS_PER_BAR * 60.0 / bpm
    total_bars = sum(b for _, b in plan)
    lead = round(lead_in_sec * SAMPLE_RATE)
    audio = np.zeros(lead + round(total_bars * bar_sec * SAMPLE_RATE) + SAMPLE_RATE, np.float32)
    sections: list[Section] = []
    bar_index = 0
    for kind, bars in plan:
        start_sec = lead_in_sec + bar_index * bar_sec
        sections.append(Section(start_sec, start_sec + bars * bar_sec, kind))
        for b in range(bars):
            rendered = render_bar(kind, b, bpm)
            start = lead + round((bar_index + b) * bar_sec * SAMPLE_RATE)
            audio[start : start + rendered.size] += rendered[: audio.size - start]
        bar_index += bars
    duration = lead_in_sec + total_bars * bar_sec
    audio = audio[: round(duration * SAMPLE_RATE)]
    if noise_db is not None:
        rng = np.random.default_rng(7)
        audio = audio + (10 ** (noise_db / 20) * rng.normal(0, 1, audio.size)).astype(np.float32)
    audio = audio / max(float(np.max(np.abs(audio))), 1e-6) * 0.8
    beat_times = np.asarray(
        lead_in_sec + np.arange(total_bars * BEATS_PER_BAR) * 60.0 / bpm, dtype=np.float64
    )
    return SyntheticSong(
        name=name,
        audio=audio.astype(np.float32),
        sample_rate=SAMPLE_RATE,
        sections=sections,
        beats=beat_times,
        downbeats=beat_times[::BEATS_PER_BAR],
    )


_POP = [
    ("intro", 4),
    ("verse", 8),
    ("chorus", 8),
    ("verse", 8),
    ("chorus", 8),
    ("bridge", 8),
    ("chorus", 8),
    ("outro", 4),
]
_SHORT = [
    ("intro", 4),
    ("verse", 8),
    ("chorus", 8),
    ("verse", 8),
    ("chorus", 8),
    ("outro", 4),
]


def suite() -> list[SyntheticSong]:
    """The standard synthetic suite: a pop form, a lead-in, a short form, a noisy mix."""
    return [
        render_song("song_pop_120bpm", _POP, 120),
        render_song("song_pop_100bpm_leadin", _POP, 100, lead_in_sec=0.8),
        render_song("song_short_128bpm", _SHORT, 128),
        render_song("song_pop_110bpm_noisy", _POP, 110, noise_db=-35),
    ]
