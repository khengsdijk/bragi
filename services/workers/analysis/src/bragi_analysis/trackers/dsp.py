"""A weight-free beat tracker: onset flux, tempo autocorrelation and dynamic programming.

This is the classic Ellis (2007) approach. It needs no model file, so it is the
fallback when Beat This! weights are not installed (04 §1.3: stages degrade
gracefully) and the test double that lets the eval harness run anywhere. It is
**not** expected to reach the v1 gate on real music; Beat This! is the v1 tracker.
"""

from __future__ import annotations

import numpy as np
from numpy.typing import NDArray
from scipy import ndimage, signal

from bragi_analysis.dsp import features
from bragi_analysis.trackers.base import BeatEstimate

type F64 = NDArray[np.float64]

N_FFT = 1024
HOP = 256
#: Peak flux appears this long before the onset (a quarter window), measured on click tracks.
ONSET_LAG_SEC = (N_FFT // 4) / 22_050

MIN_BPM = 60.0
MAX_BPM = 200.0
#: Log-normal tempo prior: centre and width (in octaves).
PRIOR_BPM = 120.0
PRIOR_OCTAVES = 1.0
#: How strongly the DP punishes deviation from the tempo period (librosa's default).
TIGHTNESS = 100.0

MIN_BEATS = 8


def _envelope(mono: NDArray[np.float32], sample_rate: int) -> tuple[F64, float]:
    magnitude = features.stft_magnitude(mono, N_FFT, HOP)
    strength = features.onset_strength(magnitude)
    fps = sample_rate / HOP
    # Remove the slowly varying floor, then scale to unit deviation.
    floor = ndimage.uniform_filter1d(strength, size=max(3, int(fps)), mode="nearest")
    flat = np.maximum(strength - floor, 0.0)
    spread = float(np.std(flat))
    return (flat / spread if spread > 1e-9 else flat), fps


def estimate_tempo(envelope: F64, fps: float) -> float:
    """Global tempo in BPM from the autocorrelation of the onset envelope."""
    lags = np.arange(int(fps * 60 / MAX_BPM), int(fps * 60 / MIN_BPM) + 2)
    acf = signal.correlate(envelope, envelope, mode="full", method="fft")[envelope.size - 1 :]
    acf = acf / (acf[0] + 1e-12)
    bpm = 60.0 * fps / lags
    prior = np.exp(-0.5 * (np.log2(bpm / PRIOR_BPM) / PRIOR_OCTAVES) ** 2)
    score = acf[lags] * prior
    best = int(np.argmax(score))
    lag = float(lags[best])
    if 0 < best < lags.size - 1:  # parabolic refinement of the peak lag
        a, b, c = score[best - 1], score[best], score[best + 1]
        denominator = a - 2 * b + c
        if abs(denominator) > 1e-12:
            lag += 0.5 * (a - c) / denominator
    return 60.0 * fps / lag


def _track(envelope: F64, period: float) -> list[int]:
    """Ellis DP: best beat sequence for an envelope given a beat period in frames."""
    n = envelope.size
    window = np.arange(-round(2 * period), -round(period / 2) + 1)
    penalty = -TIGHTNESS * np.log(-window / period) ** 2
    score = envelope.copy()
    back = np.full(n, -1, dtype=np.int64)
    for t in range(n):
        candidates = t + window
        valid = candidates >= 0
        if not valid.any():
            continue
        values = score[candidates[valid]] + penalty[valid]
        best = int(np.argmax(values))
        if values[best] > 0 or t > 2 * period:
            score[t] += values[best]
            back[t] = candidates[valid][best]
    tail = max(0, n - round(period))
    t = tail + int(np.argmax(score[tail:]))
    beats = [t]
    while back[t] >= 0:
        t = int(back[t])
        beats.append(t)
    return beats[::-1]


class DspTracker:
    """Onset-flux tracker with a 4/4 downbeat guess."""

    name = "dsp"
    stage_version = "rhythm@dsp-flux-1"

    def track(self, mono: NDArray[np.float32], sample_rate: int) -> BeatEstimate:
        """Beats and (4/4) downbeats; empty when the audio has no pulse."""
        empty = BeatEstimate(np.zeros(0), np.zeros(0))
        if mono.shape[0] < 2 * sample_rate or float(np.max(np.abs(mono))) < 1e-4:
            return empty
        envelope, fps = _envelope(mono, sample_rate)
        if float(np.max(envelope)) <= 0.0:
            return empty
        period = 60.0 * fps / estimate_tempo(envelope, fps)
        frames = np.asarray(_track(envelope, period))
        if frames.size < MIN_BEATS:
            return empty
        beats = frames / fps + ONSET_LAG_SEC
        # Downbeat phase: the bar position whose beats carry the most onset energy.
        phase_scores = [float(envelope[frames[p::4]].mean()) for p in range(4)]
        phase = int(np.argmax(phase_scores))
        return BeatEstimate(beats=beats, downbeats=beats[phase::4])
