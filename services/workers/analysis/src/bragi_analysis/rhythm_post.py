"""From raw beats and downbeats to a ``RhythmResult`` (``specs/04`` §5.1, §10).

Every tracker feeds the same post-processing, so the contract (bpm in 70..180,
alternative bpm, smoothed tempo curve, time signature, stability, confidence)
does not depend on the model.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from itertools import pairwise

import numpy as np
from numpy.typing import NDArray

from bragi_common.generated.models import (
    RhythmResult,
    RhythmResultSchemaVersion,
    RhythmTimeSignature,
    TempoCurvePoint,
    TimeSigDenominator,
)

type F64 = NDArray[np.float64]

#: 04 §5.1: prefer a bpm in this range.
BPM_MIN = 70.0
BPM_MAX = 180.0
#: 04 §5.1: bpm standard deviation below 1 % means constant tempo.
STABLE_CV = 0.01
#: 04 §10: below this the UI enters free-time mode.
LOW_CONFIDENCE = 0.4
#: Beats averaged on each side of a beat for the smoothed tempo curve.
CURVE_RADIUS = 4
#: Used when fewer than two beats were found; flagged by ``confidence == 0``.
FALLBACK_BPM = 120.0
#: A bar longer than this many beats is not a bar; assume 4.
MAX_NUMERATOR = 12


@dataclass(frozen=True)
class Folded:
    """A beat grid after octave folding."""

    beats: F64
    downbeats: F64
    bpm_factor: float


def _clean(times: F64) -> F64:
    values = np.unique(np.asarray(times, dtype=np.float64))
    return values[np.isfinite(values) & (values >= 0.0)]


def _raw_bpm(beats: F64) -> tuple[float, bool, F64]:
    """Global bpm, whether it is stable, and the smoothed per-beat curve."""
    index = np.arange(beats.size)
    low = np.maximum(index - CURVE_RADIUS, 0)
    high = np.minimum(index + CURVE_RADIUS, beats.size - 1)
    curve = 60.0 * (high - low) / (beats[high] - beats[low])
    stable = bool(np.std(curve) / np.mean(curve) < STABLE_CV)
    if stable:
        slope = np.polyfit(index, beats, 1)[0]  # seconds per beat, robust to jitter
        return float(60.0 / slope), True, curve
    return float(np.median(curve)), False, curve


def fold_octave(beats: F64, downbeats: F64, bpm: float) -> Folded:
    """Moves the grid into 70..180 bpm by halving or doubling the beat density.

    Doubling inserts a beat midway between neighbours. Halving keeps every second
    beat, with the phase chosen so the downbeats survive. The grid and the bpm
    always describe the same pulse, so the tempo map built from either agrees.
    """
    if bpm < BPM_MIN:
        mids = (beats[:-1] + beats[1:]) / 2.0
        doubled = np.sort(np.concatenate([beats, mids]))
        return Folded(doubled, downbeats, 2.0)
    if bpm > BPM_MAX:
        phase = 0
        if downbeats.size:
            phase = int(np.argmin(np.abs(beats - downbeats[0]))) % 2
        return Folded(beats[phase::2], downbeats, 0.5)
    return Folded(beats, downbeats, 1.0)


def alternative_bpm(bpm: float, raw: float, factor: float) -> float:
    """The half/double-time alternative to report (04 §5.1).

    When folding changed the tempo, the alternative is the tracker's original reading.
    Otherwise it is the other octave: double below 125 bpm, half above.
    """
    if factor != 1.0:
        return raw
    return bpm * 2.0 if bpm < 125.0 else bpm / 2.0


def time_signature(beats: F64, downbeats: F64) -> tuple[int, int]:
    """Numerator from the most common beats-per-bar; denominator 4.

    The denominator cannot be told from the beat positions alone (6/8 and 3/4 look
    alike), so it is fixed at 4 until a later stage knows better.
    """
    if downbeats.size < 2:
        return 4, 4
    positions = np.searchsorted(beats, downbeats - 1e-3)
    counts = [int(b - a) for a, b in pairwise(positions) if b > a]
    if not counts:
        return 4, 4
    numerator = Counter(counts).most_common(1)[0][0]
    return (numerator if 2 <= numerator <= MAX_NUMERATOR else 4), 4


def regularity_confidence(beats: F64, duration_sec: float) -> float:
    """A heuristic in 0..1: how steady the beats are, times how much of the song they cover.

    Beat This! reports no confidence of its own. This is the share of inter-beat
    intervals within 10 % of their local median, scaled by the fraction of the
    song between the first and last beat. Rubato and free-time music score low.
    """
    if beats.size < 4 or duration_sec <= 0.0:
        return 0.0
    intervals = np.diff(beats)
    local = np.asarray([np.median(intervals[max(0, i - 4) : i + 5]) for i in range(intervals.size)])
    steady = float(np.mean(np.abs(intervals - local) <= 0.1 * local))
    coverage = min(1.0, float(beats[-1] - beats[0] + np.median(intervals)) / duration_sec)
    return float(np.clip(steady * coverage, 0.0, 1.0))


def build_result(beats: F64, downbeats: F64, duration_sec: float) -> RhythmResult:
    """The ``RhythmResult`` for a tracker's raw output."""
    beats = _clean(beats)
    downbeats = _clean(downbeats)
    if beats.size < 2:
        return _no_pulse()

    raw_bpm, _, _ = _raw_bpm(beats)
    folded = fold_octave(beats, downbeats, raw_bpm)
    beats, downbeats = folded.beats, folded.downbeats
    bpm, stable, curve = _raw_bpm(beats)
    confidence = regularity_confidence(beats, duration_sec)
    numerator, denominator = time_signature(beats, downbeats)

    return RhythmResult(
        schemaVersion=RhythmResultSchemaVersion.integer_1,
        bpm=round(bpm, 3),
        alternativeBpm=round(alternative_bpm(bpm, raw_bpm, folded.bpm_factor), 3),
        beats=[round(float(t), 4) for t in beats],
        downbeats=[round(float(t), 4) for t in downbeats],
        tempoCurve=[TempoCurvePoint(beat=i, bpm=round(float(v), 3)) for i, v in enumerate(curve)],
        timeSignature=RhythmTimeSignature(
            numerator=numerator, denominator=TimeSigDenominator(denominator)
        ),
        confidence=round(confidence, 3),
        isTempoStable=stable,
        lowConfidence=confidence < LOW_CONFIDENCE,
    )


def _no_pulse() -> RhythmResult:
    """The result for audio with no detectable beat: flagged, never a failure (04 §10)."""
    return RhythmResult(
        schemaVersion=RhythmResultSchemaVersion.integer_1,
        bpm=FALLBACK_BPM,
        beats=[],
        downbeats=[],
        tempoCurve=[],
        timeSignature=RhythmTimeSignature(numerator=4, denominator=TimeSigDenominator(4)),
        confidence=0.0,
        isTempoStable=False,
        lowConfidence=True,
    )
