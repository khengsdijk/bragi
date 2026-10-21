"""Onset envelopes shared by the tempo, alignment and seam gates.

One STFT front end for all three, so a lag found by the beat-align search is
expressed in the same hop the seam scoring uses. The feature functions come from
``bragi_analysis.dsp.features`` (the analysis worker's own front end); only the
floor removal is local, so the envelopes are mean-free and comparable.
"""

from __future__ import annotations

import numpy as np
from numpy.typing import NDArray

from bragi_analysis.dsp.features import onset_strength, stft_magnitude

type F32 = NDArray[np.float32]
type F64 = NDArray[np.float64]

#: STFT of the onset front end: 1024 samples ≈ 21 ms at 48 kHz, hop ≈ 5.3 ms.
N_FFT = 1024
HOP = 256


def envelope(mono: F32, sample_rate: int, *, floored: bool = True) -> tuple[F64, float]:
    """An onset envelope and its frame rate.

    ``floored`` removes the slow level (the tracker front end does the same);
    alignment and seam scoring want the raw flux instead, because a seam is
    exactly a step in it.
    """
    magnitude = stft_magnitude(mono, N_FFT, HOP)
    strength = onset_strength(magnitude)
    fps = sample_rate / HOP
    if not floored:
        return np.asarray(strength, dtype=np.float64), fps
    floor = np.convolve(strength, np.ones(max(3, int(fps))) / max(3, int(fps)), mode="same")
    flat = np.maximum(strength - floor, 0.0)
    spread = float(np.std(flat))
    return (np.asarray(flat / spread, dtype=np.float64) if spread > 1e-9 else flat), fps


def frame_times(count: int, fps: float) -> F64:
    """Centre time of each analysis frame in seconds."""
    return np.arange(count, dtype=np.float64) / fps
