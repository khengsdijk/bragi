"""Key estimation, roman numerals and the progression fingerprint (``specs/04`` §5.3).

Key is estimated from the harmonic chroma with the Krumhansl-Schmuckler profiles
and refined by the decoded chord sequence; the roman numerals are relative to the
tonic, which is what makes a transposed song produce the same numerals (and so the
same :func:`fingerprint`). No model weights and no I/O.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

from bragi_analysis.harmony.chords import INTERVALS, ChordSegment
from bragi_analysis.harmony.chroma import ChromaFrames

type F32 = NDArray[np.float32]
type F64 = NDArray[np.float64]

#: Krumhansl-Schmuckler key profiles (Krumhansl 1990), one weight per pitch class
#: starting on the tonic.
KRUMHANSL_MAJOR: F64 = np.asarray(
    [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88], dtype=np.float64
)
KRUMHANSL_MINOR: F64 = np.asarray(
    [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17], dtype=np.float64
)
#: Scale degrees in semitones from the tonic.
MAJOR_SCALE: tuple[int, ...] = (0, 2, 4, 5, 7, 9, 11)
MINOR_SCALE: tuple[int, ...] = (0, 2, 3, 5, 7, 8, 10)
_DEGREE_ROMAN: tuple[str, ...] = ("I", "II", "III", "IV", "V", "VI", "VII")
#: Lowercase numerals for these qualities, uppercase otherwise.
_LOWERCASE: frozenset[str] = frozenset({"min", "min7", "min6", "min7b5", "dim", "dim7", "minMaj7"})
_QUALITY_SUFFIX: dict[str, str] = {
    "maj": "",
    "min": "",
    "dim": "\u00b0",
    "aug": "+",
    "sus2": "sus2",
    "sus4": "sus4",
    "maj7": "maj7",
    "min7": "7",
    "7": "7",
    "min7b5": "\u00f87",
    "dim7": "\u00b07",
    "maj6": "6",
    "min6": "6",
    "minMaj7": "maj7",
}
#: How much the chord sequence weighs against the raw chroma in the refined key fit.
CHORD_REFINE_WEIGHT = 0.5
#: Scale of the margin-to-confidence conversion for the key.
_MARGIN_SCALE = 6.0
#: Local-key confidence below which a window cannot start a key change.
KEY_CHANGE_MIN_CONFIDENCE = 0.5
#: Length of the windows used to look for a key change.
KEY_CHANGE_WINDOW_SEC = 8.0
#: Windows a new key must persist before it is published as a change.
KEY_CHANGE_MIN_RUN = 2
#: Fingerprint marker for a section with no confident chord.
NO_CHORD_MARKER = "N"


@dataclass(frozen=True)
class Key:
    """An estimated key."""

    tonic_pc: int
    mode: str
    confidence: float

    @property
    def label(self) -> str:
        """``"F#"`` and ``"major"`` — the two fields the schema stores."""
        from bragi_analysis.harmony.chroma import NOTE_NAMES

        return f"{NOTE_NAMES[self.tonic_pc % 12]} {self.mode}"


@dataclass(frozen=True)
class KeyChange:
    """A detected modulation."""

    at_sec: float
    tonic_pc: int
    mode: str
    confidence: float


def _profile_correlations(mean: F64) -> list[tuple[float, int, str]]:
    """``(correlation, tonic, mode)`` for every candidate key, best first."""
    n = mean - mean.mean()
    candidates: list[tuple[float, int, str]] = []
    for mode, profile in (("major", KRUMHANSL_MAJOR), ("minor", KRUMHANSL_MINOR)):
        p = profile - profile.mean()
        pn = p / float(np.linalg.norm(p))
        for tonic in range(12):
            rotated = np.roll(n, -tonic)
            rotated_norm = float(np.linalg.norm(rotated))
            corr = float(np.dot(rotated, pn) / rotated_norm) if rotated_norm > 1e-9 else 0.0
            candidates.append((corr, tonic, mode))
    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates


def estimate_key(vectors: F32, energy: F64, extra: F64 | None = None) -> Key:
    """Estimates the key from energy-weighted chroma, optionally mixed with ``extra``.

    ``extra`` is the duration-weighted chord-template chroma (04 §5.3: "refined by
    the chord sequence"). Silence, or a chroma with no direction, gives confidence 0.
    """
    if vectors.shape[0] == 0:
        return Key(0, "major", 0.0)
    weights = np.clip(energy, 0.0, None)
    if float(weights.sum()) <= 0.0:
        weights = np.ones(vectors.shape[0], dtype=np.float64)
    mean = np.asarray(vectors, dtype=np.float64).T @ weights
    norm = float(np.linalg.norm(mean))
    if norm <= 1e-9:
        return Key(0, "major", 0.0)
    mean = mean / norm
    if extra is not None and float(np.linalg.norm(extra)) > 1e-9:
        unit = extra / float(np.linalg.norm(extra))
        mean = (1.0 - CHORD_REFINE_WEIGHT) * mean + CHORD_REFINE_WEIGHT * unit
        mean = mean / float(np.linalg.norm(mean))
    candidates = _profile_correlations(mean)
    best_corr, tonic, mode = candidates[0]
    if best_corr <= 0.0:
        return Key(tonic, mode, 0.0)
    margin = best_corr - candidates[1][0]
    # Both the absolute fit and the lead over the runner-up matter: a flat,
    # directionless chroma can still have a "best" key by a small margin.
    confidence = float(best_corr) * float(np.clip(_MARGIN_SCALE * margin, 0.0, 1.0))
    return Key(tonic, mode, float(np.clip(confidence, 0.0, 1.0)))


def chord_chroma(segments: Sequence[ChordSegment]) -> F64:
    """The duration- and confidence-weighted chord-template chroma of ``segments``."""
    vector = np.zeros(12, dtype=np.float64)
    for segment in segments:
        weight = max(segment.end_sec - segment.start_sec, 0.0) * max(segment.confidence, 0.0)
        for interval in INTERVALS.get(segment.quality, ()):
            vector[(segment.root_pc + interval) % 12] += weight
    return vector


def detect_key_changes(
    frames: ChromaFrames,
    global_key: Key,
    *,
    window_sec: float = KEY_CHANGE_WINDOW_SEC,
    min_run: int = KEY_CHANGE_MIN_RUN,
    min_confidence: float = KEY_CHANGE_MIN_CONFIDENCE,
) -> list[KeyChange]:
    """Sustained local keys that differ from the global one, in time order.

    Local keys are estimated on ``window_sec`` windows; a different key must hold
    for ``min_run`` consecutive confident windows before it is published, which
    keeps a single misread window from adding a change.
    """
    count = frames.vectors.shape[0]
    if count == 0 or frames.edges.size == 0:
        return []
    duration_sec = float(frames.edges[-1])
    centres = frames.frame_centres
    if duration_sec <= 2.0 * window_sec:
        return []
    changes: list[KeyChange] = []
    active = (global_key.tonic_pc, global_key.mode)
    candidate: tuple[int, str, float] | None = None
    run = 0
    window = 0
    while window * window_sec < duration_sec:
        start = window * window_sec
        end = min(start + window_sec, duration_sec)
        indices = np.where((centres >= start) & (centres < end))[0]
        window += 1
        if indices.size < 3:
            candidate, run = None, 0
            continue
        local = estimate_key(frames.vectors[indices], frames.energy[indices])
        key = (local.tonic_pc, local.mode)
        if key != active and local.confidence >= min_confidence:
            if candidate is not None and (candidate[0], candidate[1]) == key:
                run += 1
            else:
                candidate, run = (key[0], key[1], start), 1
            if run >= min_run:
                changes.append(
                    KeyChange(
                        at_sec=candidate[2],
                        tonic_pc=key[0],
                        mode=key[1],
                        confidence=local.confidence,
                    )
                )
                active = key
                candidate, run = None, 0
        else:
            candidate, run = None, 0
    return changes


def _degree(rel: int, scale: tuple[int, ...]) -> str:
    """The roman-numeral label of a pitch class ``rel`` semitones above the tonic."""
    for degree, semitone in enumerate(scale):
        if rel == semitone:
            return _DEGREE_ROMAN[degree]
    for degree in range(7):
        lower = scale[degree]
        upper = scale[(degree + 1) % 7]
        if (upper - lower) % 12 == 2 and rel == (lower + 1) % 12:
            # Prefer the flat spelling between two scale tones: bII, bIII, bV, …
            return "b" + _DEGREE_ROMAN[(degree + 1) % 7]
    return "?"  # unreachable for a diatonic scale; keeps callers total


def roman_numeral(root_pc: int, quality: str, key: Key) -> str:
    """The roman numeral of a chord relative to ``key`` (case and suffix from the quality)."""
    scale = MAJOR_SCALE if key.mode == "major" else MINOR_SCALE
    label = _degree((root_pc - key.tonic_pc) % 12, scale)
    text = label.lower() if quality in _LOWERCASE else label
    return text + _QUALITY_SUFFIX.get(quality, "")


def fingerprint(numerals: Sequence[str]) -> str:
    """The normalised roman-numeral sequence (04 §5.3): repeats collapsed, joined by ``-``."""
    collapsed: list[str] = [n for i, n in enumerate(numerals) if i == 0 or n != numerals[i - 1]]
    return "-".join(collapsed) if collapsed else NO_CHORD_MARKER
