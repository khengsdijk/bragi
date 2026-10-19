"""Self-similarity matrix and novelty-based boundary detection (Foote, 2000).

A boundary is where the music stops resembling what came before and starts resembling what
comes after: a checkerboard kernel slid along the diagonal of the self-similarity matrix
(SSM) responds exactly to that.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray
from scipy import signal

type F64 = NDArray[np.float64]

#: Kernel half-width in beats: the kernel looks 16 beats (4 bars of 4/4) either side.
KERNEL_HALF_BEATS = 16
#: Two boundaries closer than this many beats are one boundary (the stronger wins).
MIN_SECTION_BEATS = 8
#: A peak must exceed ``mean + HEIGHT_STD * std`` of the novelty curve ...
HEIGHT_STD = 0.25
#: ... and this share of the strongest peak, so a flat curve yields no boundaries.
HEIGHT_REL = 0.2
#: Below this the strongest novelty is noise, not structure.
MIN_PEAK_ABS = 0.05


def self_similarity(features: F64) -> F64:
    """Cosine self-similarity of ``(beats, dims)`` features, in ``[-1, 1]``."""
    norms = np.linalg.norm(features, axis=1, keepdims=True)
    unit = features / np.maximum(norms, 1e-9)
    return np.asarray(unit @ unit.T)


def _checkerboard(half: int) -> F64:
    """A Gaussian-tapered checkerboard kernel of side ``2 * half``."""
    axis = np.arange(-half, half) + 0.5
    taper = np.exp(-0.5 * (axis / (half / 2.0)) ** 2)
    sign = np.sign(axis)
    return np.outer(taper * sign, taper * sign)


def novelty_curve(ssm: F64, half: int = KERNEL_HALF_BEATS) -> F64:
    """Novelty per beat: the checkerboard response on the SSM diagonal.

    The kernel is shrunk for short songs so that at least a quarter of the song fits on each
    side. The SSM is zero-padded, which damps the first and last ``half`` beats on purpose: a
    boundary needs context on both sides.
    """
    n = ssm.shape[0]
    half = int(max(2, min(half, n // 4)))
    kernel = _checkerboard(half)
    padded = np.pad(ssm, half, mode="constant")
    curve = np.zeros(n)
    for i in range(n):
        window = padded[i : i + 2 * half, i : i + 2 * half]
        curve[i] = float(np.sum(window * kernel))
    return np.maximum(curve, 0.0) / float(np.sum(np.abs(kernel)))


@dataclass(frozen=True)
class Boundaries:
    """Boundary beat indices with the novelty value at each."""

    beat_index: list[int]
    strength: list[float]
    curve: F64


def pick_boundaries(curve: F64, min_gap_beats: int = MIN_SECTION_BEATS) -> Boundaries:
    """Peaks of ``curve`` that stand out, at least ``min_gap_beats`` apart."""
    if curve.size < 3 or float(curve.max()) < MIN_PEAK_ABS:
        return Boundaries([], [], curve)
    height = max(
        float(curve.mean() + HEIGHT_STD * curve.std()),
        HEIGHT_REL * float(curve.max()),
        MIN_PEAK_ABS,
    )
    peaks, _ = signal.find_peaks(curve, height=height, distance=max(1, min_gap_beats))
    return Boundaries([int(p) for p in peaks], [float(curve[p]) for p in peaks], curve)
