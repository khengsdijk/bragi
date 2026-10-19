"""Windowing and pooling for embeddings (``specs/04`` §6.1).

The spec fixes 10 s windows with a 5 s hop, mean-pooled. This module owns that rule and the
scope pooling: a window's vector is weighted by how much of the window lies inside the
requested spans (everything, for a whole song; a section's span; a stem's active regions), then
the weighted mean is L2-normalised. Keeping the window grid over the whole signal — instead of
slicing each scope — makes the result independent of where a slice would happen to start.
"""

from __future__ import annotations

from collections.abc import Sequence

import numpy as np
from numpy.typing import NDArray

type F64 = NDArray[np.float64]

#: 04 §6.1: window and hop.
WINDOW_SEC = 10.0
HOP_SEC = 5.0
#: The v1 CLAP-family vector length (04 §6.1).
DIM = 512


def window_spans(
    duration_sec: float, window_sec: float = WINDOW_SEC, hop_sec: float = HOP_SEC
) -> list[tuple[float, float]]:
    """The ``(startSec, endSec)`` windows covering ``duration_sec``.

    Starts every ``hop_sec`` until the window reaches the end; the last window is clamped to
    the duration, so a 25 s clip yields ``(0,10) (5,15) (10,20) (15,25)``. Clips no longer than
    one window yield a single window covering them.
    """
    duration = float(duration_sec)
    if duration <= 0.0:
        return []
    if duration <= window_sec:
        return [(0.0, duration)]
    count = int(np.ceil((duration - window_sec) / hop_sec)) + 1
    return [(i * hop_sec, min(i * hop_sec + window_sec, duration)) for i in range(max(1, count))]


def coverage(window: tuple[float, float], spans: Sequence[tuple[float, float]]) -> float:
    """The fraction of ``window`` inside the union of ``spans`` (1.0 when ``spans`` is empty)."""
    if not spans:
        return 1.0
    start, end = window
    width = end - start
    if width <= 0:
        return 0.0
    inside = sum(max(0.0, min(end, hi) - max(start, lo)) for lo, hi in spans)
    return float(min(1.0, inside / width))


#: The deterministic vector a silent/too-short audio pool collapses to (04 §6.1: L2-normalised).
def silence_vector(dim: int = DIM) -> F64:
    """A fixed unit vector, so a degraded result is still a valid L2-normalised embedding."""
    vector = np.ones(dim, dtype=np.float64)
    return vector / np.linalg.norm(vector)


def pool(
    vectors: Sequence[F64], weights: Sequence[float] | None = None, dim: int = DIM
) -> tuple[F64, bool]:
    """The L2-normalised weighted mean of ``vectors``, and whether it degraded.

    Returns `(silence_vector, True)` for an all-zero pool (digital silence, or weights that sum
    to zero) so the caller can flag ``lowConfidence`` without publishing an un-normalised vector.
    """
    if not vectors:
        return silence_vector(dim), True
    stacked = np.stack([np.asarray(v, dtype=np.float64) for v in vectors])
    if weights is None:
        weight = np.ones(stacked.shape[0], dtype=np.float64)
    else:
        weight = np.asarray(weights, dtype=np.float64)
    total = float(weight.sum())
    if total <= 0.0:
        return silence_vector(stacked.shape[1]), True
    pooled = (stacked * weight[:, None]).sum(axis=0) / total
    norm = float(np.linalg.norm(pooled))
    if norm < 1e-9:
        return silence_vector(stacked.shape[1]), True
    return pooled / norm, False


def unit(vector: NDArray[np.floating]) -> F64:
    """An L2-normalised copy of ``vector`` (a fixed unit vector for a zero vector)."""
    out = np.asarray(vector, dtype=np.float64)
    norm = float(np.linalg.norm(out))
    return out / norm if norm >= 1e-9 else silence_vector(out.shape[-1])


__all__ = [
    "DIM",
    "HOP_SEC",
    "WINDOW_SEC",
    "coverage",
    "pool",
    "silence_vector",
    "unit",
    "window_spans",
]
