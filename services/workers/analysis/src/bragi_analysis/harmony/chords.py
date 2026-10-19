"""Chord templates and the change-penalised Viterbi decoder (``specs/04`` §5.3).

The v1 recogniser is weight-free: a bank of root-position chord templates is
matched against each frame's chroma, and a Viterbi pass with a change penalty turns
per-frame scores into stable chord segments. A "no chord" state absorbs silence and
inharmonic frames so they never become chords.

The :class:`ChordRecognizer` protocol is the seam for a neural recogniser later
([ADR-0008](../../../../../../specs/decisions/ADR-0008-chord-detection.md)); the
published contract (segments on a time grid) does not depend on which one runs.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

import numpy as np
from numpy.typing import NDArray

from bragi_analysis.harmony.chroma import ChromaFrames

type F32 = NDArray[np.float32]
type F64 = NDArray[np.float64]

#: Extra state index for "no chord" (silence or inharmonic).
NO_CHORD = -1


@dataclass(frozen=True)
class ChordQuality:
    """A chord quality: its display name and its pitch-class intervals from the root."""

    name: str
    intervals: tuple[int, ...]


#: The v1 template bank, from common triads to seventh chords.
CHORD_QUALITIES: tuple[ChordQuality, ...] = (
    ChordQuality("maj", (0, 4, 7)),
    ChordQuality("min", (0, 3, 7)),
    ChordQuality("dim", (0, 3, 6)),
    ChordQuality("aug", (0, 4, 8)),
    ChordQuality("sus2", (0, 2, 7)),
    ChordQuality("sus4", (0, 5, 7)),
    ChordQuality("maj7", (0, 4, 7, 11)),
    ChordQuality("min7", (0, 3, 7, 10)),
    ChordQuality("7", (0, 4, 7, 10)),
    ChordQuality("min7b5", (0, 3, 6, 10)),
    ChordQuality("dim7", (0, 3, 6, 9)),
    ChordQuality("maj6", (0, 4, 7, 9)),
    ChordQuality("min6", (0, 3, 7, 9)),
    ChordQuality("minMaj7", (0, 3, 7, 11)),
)

#: Pitch-class intervals by quality name (used for the chord-chroma refinement).
INTERVALS: dict[str, tuple[int, ...]] = {q.name: q.intervals for q in CHORD_QUALITIES}

#: How a quality is written after the root in a display symbol, e.g. ``F#m7``.
DISPLAY_SUFFIX: dict[str, str] = {
    "maj": "",
    "min": "m",
    "dim": "dim",
    "aug": "aug",
    "sus2": "sus2",
    "sus4": "sus4",
    "maj7": "maj7",
    "min7": "m7",
    "7": "7",
    "min7b5": "m7b5",
    "dim7": "dim7",
    "maj6": "6",
    "min6": "m6",
    "minMaj7": "mMaj7",
}


def _template_matrix() -> tuple[F32, list[tuple[int, str]]]:
    """The ``(states, 12)`` unit-norm template matrix and the ``(root, quality)`` per row."""
    states = [(root, quality.name) for quality in CHORD_QUALITIES for root in range(12)]
    matrix = np.zeros((len(states), 12), dtype=np.float32)
    for row, (root, name) in enumerate(states):
        for interval in INTERVALS[name]:
            matrix[row, (root + interval) % 12] = 1.0
    matrix /= np.linalg.norm(matrix, axis=1, keepdims=True)
    return matrix, states


#: Built once: the template matrix and its state list.
TEMPLATES, STATE_LABELS = _template_matrix()


@dataclass(frozen=True)
class ChordSegment:
    """One decoded chord over a half-open ``[start_sec, end_sec)`` interval."""

    start_sec: float
    end_sec: float
    root_pc: int
    quality: str
    confidence: float

    @property
    def symbol(self) -> str:
        """The display symbol, e.g. ``"F#m7"``."""
        from bragi_analysis.harmony.chroma import NOTE_NAMES

        return NOTE_NAMES[self.root_pc % 12] + DISPLAY_SUFFIX.get(self.quality, self.quality)


class ChordRecognizer(Protocol):
    """What the pipeline needs from a recogniser; implemented by the template decoder."""

    @property
    def name(self) -> str:
        """A short identifier for logs and the eval report."""
        ...

    def recognize(self, frames: ChromaFrames) -> list[ChordSegment]:
        """Chord segments covering ``frames``, in time order."""
        ...


class TemplateRecognizer:
    """The weight-free v1 recogniser (04 §5.3): chroma templates + Viterbi."""

    name = "chroma-template"

    def __init__(self, *, change_penalty: float = 0.25, min_chord_sec: float = 0.15) -> None:
        """``change_penalty`` trades segment stability against tracking speed."""
        self.change_penalty = change_penalty
        self.min_chord_sec = min_chord_sec

    def recognize(self, frames: ChromaFrames) -> list[ChordSegment]:
        """Decodes the frames into chord segments."""
        return decode(frames, change_penalty=self.change_penalty, min_chord_sec=self.min_chord_sec)


def select(recognizer: str = "auto") -> ChordRecognizer:
    """Returns the recogniser to run; ``auto`` and ``template`` both mean the template one."""
    if recognizer in ("auto", "template"):
        return TemplateRecognizer()
    raise ValueError(f"unknown recognizer {recognizer!r}")


def _viterbi(emission: F64, change_penalty: float) -> NDArray[np.int64]:
    """Viterbi over ``(frames, states)`` scores with a fixed penalty per state change."""
    frames, states = emission.shape
    dp = emission[0].copy()
    back = np.zeros((frames, states), dtype=np.int64)
    index = np.arange(states)
    for t in range(1, frames):
        order = np.argsort(dp)
        best, second = int(order[-1]), int(order[-2])
        from_other = np.where(index != best, dp[best], dp[second]) - change_penalty
        stay = dp
        change = from_other > stay
        dp = emission[t] + np.where(change, from_other, stay)
        back[t] = np.where(change, best, index)
    decoded = np.zeros(frames, dtype=np.int64)
    decoded[-1] = int(np.argmax(dp))
    for t in range(frames - 1, 0, -1):
        decoded[t - 1] = back[t, decoded[t]]
    return decoded


def decode(
    frames: ChromaFrames,
    *,
    change_penalty: float = 0.25,
    min_chord_sec: float = 0.15,
    silence_share: float = 0.05,
) -> list[ChordSegment]:
    """Decodes chroma frames into non-overlapping chord segments.

    Frames whose band energy is below ``silence_share`` of the median are treated
    as silent and decode to the no-chord state; ``min_chord_sec`` segments are
    merged into their neighbour so the output is not jittery.
    """
    count = frames.vectors.shape[0]
    if count == 0:
        return []
    median = float(np.median(frames.energy))
    threshold = max(1e-9, silence_share * median)
    active = frames.energy > threshold

    similarity = frames.vectors @ TEMPLATES.T
    states = similarity.shape[1] + 1
    emission = np.empty((count, states), dtype=np.float64)
    emission[:, : similarity.shape[1]] = similarity
    emission[:, similarity.shape[1]] = 0.15
    emission[~active, : similarity.shape[1]] = -1e9
    emission[~active, similarity.shape[1]] = 0.0

    decoded = _viterbi(emission, change_penalty)
    labels = np.where(decoded == similarity.shape[1], NO_CHORD, decoded)

    segments: list[ChordSegment] = []
    start = 0
    while start < count:
        end = start
        while end + 1 < count and labels[end + 1] == labels[start]:
            end += 1
        state = int(labels[start])
        if state != NO_CHORD:
            root, quality = STATE_LABELS[state]
            match = float(np.mean(similarity[start : end + 1, state]))
            segments.append(
                ChordSegment(
                    start_sec=float(frames.edges[start]),
                    end_sec=float(frames.edges[end + 1]),
                    root_pc=root,
                    quality=quality,
                    confidence=float(np.clip(match, 0.0, 1.0)),
                )
            )
        start = end + 1
    return _tidy(segments, min_chord_sec)


def _tidy(segments: list[ChordSegment], min_chord_sec: float) -> list[ChordSegment]:
    """Merges too-short and now-adjacent segments, preserving the earlier chord."""
    absorbed: list[ChordSegment] = []
    for segment in segments:
        if segment.end_sec - segment.start_sec < min_chord_sec and absorbed:
            previous = absorbed[-1]
            absorbed[-1] = ChordSegment(
                previous.start_sec,
                segment.end_sec,
                previous.root_pc,
                previous.quality,
                previous.confidence,
            )
        else:
            absorbed.append(segment)
    merged: list[ChordSegment] = []
    for segment in absorbed:
        if merged and (segment.root_pc, segment.quality) == (
            merged[-1].root_pc,
            merged[-1].quality,
        ):
            previous = merged[-1]
            merged[-1] = ChordSegment(
                previous.start_sec,
                segment.end_sec,
                previous.root_pc,
                previous.quality,
                previous.confidence,
            )
        else:
            merged.append(segment)
    return merged


__all__ = [
    "CHORD_QUALITIES",
    "DISPLAY_SUFFIX",
    "INTERVALS",
    "NO_CHORD",
    "STATE_LABELS",
    "TEMPLATES",
    "ChordRecognizer",
    "ChordSegment",
    "TemplateRecognizer",
    "decode",
    "select",
]
