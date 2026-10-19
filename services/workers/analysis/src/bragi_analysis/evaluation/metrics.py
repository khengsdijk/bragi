"""Beat metrics for the eval gate (``specs/04`` §8)."""

from __future__ import annotations

import mir_eval
import numpy as np
from numpy.typing import NDArray

#: 04 §8: beat F-measure with a +-70 ms window.
BEAT_TOLERANCE_SEC = 0.07
#: 04 §8: the v1 gate for `rhythm`.
BEAT_F_GATE = 0.85


def beat_f_measure(
    reference: NDArray[np.float64],
    estimate: NDArray[np.float64],
    tolerance_sec: float = BEAT_TOLERANCE_SEC,
) -> float:
    """``mir_eval`` beat F-measure at +-``tolerance_sec`` (no leading-seconds trim).

    Two empty sequences score 1.0 (nothing to find, nothing found); one empty
    side scores 0.0.
    """
    if reference.size == 0 and estimate.size == 0:
        return 1.0
    if reference.size == 0 or estimate.size == 0:
        return 0.0
    return float(
        mir_eval.beat.f_measure(
            np.sort(reference), np.sort(estimate), f_measure_threshold=tolerance_sec
        )
    )
