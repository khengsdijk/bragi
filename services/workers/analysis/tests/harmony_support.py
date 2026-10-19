"""Synthetic, licence-free harmony fixtures for the tests (13 §1.7).

Every signal is generated from sine partials, so no audio file is checked in and
the chord ground truth is exact. ``mir_eval`` reads the ``"C:maj"`` style labels.
"""

from __future__ import annotations

import numpy as np
from numpy.typing import NDArray

from bragi_analysis.harmony import chords
from bragi_analysis.harmony.chroma import NOTE_NAMES

SAMPLE_RATE = 11_025
CHORD_SEC = 1.8
type Progress = list[tuple[int, str]]


def _tone(seconds: float, freq: float, sample_rate: int, amplitude: float) -> NDArray[np.float32]:
    """A three-partial tone with a short attack and release, so joins do not click."""
    t = np.arange(round(seconds * sample_rate)) / sample_rate
    envelope = np.clip(np.minimum(t / 0.02, (seconds - t) / 0.05), 0.0, 1.0)
    wave = (
        np.sin(2 * np.pi * freq * t)
        + 0.5 * np.sin(2 * np.pi * 2 * freq * t)
        + 0.25 * np.sin(2 * np.pi * 3 * freq * t)
    )
    return (amplitude * envelope * wave).astype(np.float32)


def chord_audio(
    root_pc: int,
    quality: str,
    *,
    seconds: float = CHORD_SEC,
    sample_rate: int = SAMPLE_RATE,
) -> NDArray[np.float32]:
    """One root-position chord around C4 (middle C)."""
    total = np.zeros(round(seconds * sample_rate), dtype=np.float32)
    for interval in chords.INTERVALS[quality]:
        midi = 60 + root_pc + interval
        total += _tone(seconds, 440.0 * 2.0 ** ((midi - 69) / 12.0), sample_rate, 0.3)
    return total


def render(
    progression: Progress,
    *,
    reps: int = 2,
    seconds: float = CHORD_SEC,
    sample_rate: int = SAMPLE_RATE,
    transpose: int = 0,
) -> NDArray[np.float32]:
    """A looped progression, normalised to 0.7 peak so a 16-bit WAV does not clip."""
    parts = [
        chord_audio((root + transpose) % 12, quality, seconds=seconds, sample_rate=sample_rate)
        for _ in range(reps)
        for root, quality in progression
    ]
    audio = np.concatenate(parts)
    peak = float(np.max(np.abs(audio)))
    return np.asarray(audio * (0.7 / peak if peak else 1.0), dtype=np.float32)


def reference(
    progression: Progress,
    *,
    reps: int = 2,
    seconds: float = CHORD_SEC,
    transpose: int = 0,
) -> tuple[NDArray[np.float64], list[str]]:
    """The ``(intervals, labels)`` ground truth of :func:`render`, for ``mir_eval``."""
    intervals: list[list[float]] = []
    labels: list[str] = []
    time = 0.0
    for _ in range(reps):
        for root, quality in progression:
            intervals.append([time, time + seconds])
            labels.append(f"{NOTE_NAMES[(root + transpose) % 12]}:{quality}")
            time += seconds
    return np.asarray(intervals, dtype=np.float64), labels


def detected(segments: list[chords.ChordSegment]) -> tuple[NDArray[np.float64], list[str]]:
    """The ``(intervals, labels)`` of decoded segments, for ``mir_eval``."""
    intervals = np.asarray([[s.start_sec, s.end_sec] for s in segments], dtype=np.float64)
    labels = [f"{NOTE_NAMES[s.root_pc % 12]}:{s.quality}" for s in segments]
    return intervals, labels
