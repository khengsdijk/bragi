"""Snapping boundaries to the musical grid (``specs/04`` §5.2).

"Boundaries are snapped to the nearest downbeat and then to a 2-/4-bar phrase grid when within
+-1 beat." Implemented as: the phrase grid is every 4th (then every 2nd) downbeat counted from
the first downbeat; a raw boundary within one beat of a 4-bar grid line goes there, else within
one beat of a 2-bar grid line goes there, else to the nearest downbeat.
"""

from __future__ import annotations

import numpy as np
from numpy.typing import NDArray

type F64 = NDArray[np.float64]

#: Grid spacings in bars, tried in order.
PHRASE_BARS = (4, 2)


def snap_to_grid(time_sec: float, beats: F64, downbeats: F64) -> float:
    """The snapped time of one raw boundary ``time_sec``.

    Without downbeats nothing can be snapped bar-wise; the boundary goes to the nearest beat.
    """
    if beats.size == 0:
        return time_sec
    nearest_beat = float(beats[int(np.argmin(np.abs(beats - time_sec)))])
    if downbeats.size == 0:
        return nearest_beat
    beat_sec = float(np.median(np.diff(beats))) if beats.size > 1 else 0.5
    for bars in PHRASE_BARS:
        grid = downbeats[::bars]
        candidate = float(grid[int(np.argmin(np.abs(grid - time_sec)))])
        if abs(candidate - time_sec) <= beat_sec * 1.0 + 1e-9:
            return candidate
    return float(downbeats[int(np.argmin(np.abs(downbeats - time_sec)))])


def snap_boundaries(
    times: list[float], beats: F64, downbeats: F64, min_gap_sec: float
) -> list[float]:
    """Snaps every boundary; drops any that collapse onto another or sit within ``min_gap_sec``.

    ``times`` must be ordered by strength is *not* required: later boundaries that land within
    ``min_gap_sec`` of an earlier kept one are dropped, so pass them strongest first when that
    matters. The result is sorted ascending.
    """
    kept: list[float] = []
    for raw in times:
        snapped = snap_to_grid(raw, beats, downbeats)
        if all(abs(snapped - k) >= min_gap_sec for k in kept):
            kept.append(snapped)
    return sorted(kept)
