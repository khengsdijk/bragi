"""The beat-tracker seam (``specs/04`` §1.5: models are swappable)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

import numpy as np
from numpy.typing import NDArray

type F64 = NDArray[np.float64]

#: Every tracker works on mono audio at this rate (Beat This! resamples to it anyway).
TRACKER_SAMPLE_RATE = 22_050


@dataclass(frozen=True)
class BeatEstimate:
    """Raw tracker output, in seconds of the working asset."""

    beats: F64
    downbeats: F64


class BeatTracker(Protocol):
    """Anything that turns mono audio into beats and downbeats."""

    @property
    def name(self) -> str:
        """Short id, e.g. ``beat_this``."""
        ...

    @property
    def stage_version(self) -> str:
        """The ``stageVersion`` of 04 §1.5, e.g. ``rhythm@beat_this-final0-1``."""
        ...

    def track(self, mono: NDArray[np.float32], sample_rate: int) -> BeatEstimate:
        """Tracks one mono signal. Blocking and CPU/GPU bound: call it from a thread."""
        ...
