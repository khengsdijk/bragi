"""Frame-level spectral features shared by the energy curve and the DSP beat tracker."""

from __future__ import annotations

import numpy as np
from numpy.typing import NDArray
from scipy import signal

type F32 = NDArray[np.float32]
type F64 = NDArray[np.float64]


def stft_magnitude(x: NDArray[np.floating], n_fft: int, hop: int) -> F32:
    """Magnitude STFT of shape ``(frames, n_fft // 2 + 1)``, Hann window, zero-padded tail.

    Frame ``f`` is centred on sample ``f * hop`` (the signal is padded by ``n_fft // 2``).
    """
    padded = np.pad(x.astype(np.float32), (n_fft // 2, n_fft // 2))
    frames = max(1, 1 + (padded.shape[0] - n_fft) // hop)
    needed = (frames - 1) * hop + n_fft
    if padded.shape[0] < needed:
        padded = np.pad(padded, (0, needed - padded.shape[0]))
    windowed = np.lib.stride_tricks.sliding_window_view(padded, n_fft)[::hop][:frames]
    window = np.hanning(n_fft).astype(np.float32)
    return np.abs(np.fft.rfft(windowed * window, axis=1)).astype(np.float32)


def onset_strength(magnitude: F32) -> F64:
    """Log-compressed, half-wave rectified spectral flux per frame (first frame is 0)."""
    compressed = np.log1p(100.0 * magnitude)
    flux = np.maximum(np.diff(compressed, axis=0, prepend=compressed[:1]), 0.0).sum(axis=1)
    return flux.astype(np.float64)


def spectral_centroid_hz(magnitude: F32, sample_rate: int, n_fft: int) -> F64:
    """Per-frame spectral centroid in Hz (0 for silent frames)."""
    freqs = np.fft.rfftfreq(n_fft, 1.0 / sample_rate)
    total = magnitude.sum(axis=1)
    weighted = magnitude @ freqs
    return np.where(total > 1e-9, weighted / np.maximum(total, 1e-9), 0.0)


def per_hop(
    values: F64, frame_times: F64, hop_sec: float, count: int, weights: F64 | None = None
) -> F64:
    """Weighted mean of frame ``values`` inside each of ``count`` hops (0 where empty)."""
    index = np.clip((frame_times // hop_sec).astype(np.int64), 0, count - 1)
    w = np.ones_like(values) if weights is None else weights
    totals = np.bincount(index, weights=values * w, minlength=count)
    mass = np.bincount(index, weights=w, minlength=count)
    return np.where(mass > 0, totals / np.maximum(mass, 1e-12), 0.0)


def onset_density_per_hop(strength: F64, frame_times: F64, hop_sec: float, count: int) -> F64:
    """Onsets per second inside each hop, from peaks of the onset strength."""
    if strength.size < 3 or float(np.std(strength)) < 1e-9:
        return np.zeros(count)
    height = float(np.mean(strength) + 0.5 * np.std(strength))
    peaks, _ = signal.find_peaks(strength, height=height, distance=3)
    index = np.clip((frame_times[peaks] // hop_sec).astype(np.int64), 0, count - 1)
    return np.bincount(index, minlength=count).astype(np.float64) / hop_sec
