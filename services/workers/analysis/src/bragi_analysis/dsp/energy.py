"""The energy curve of ``specs/04`` §5.5, one value per 0.5 s hop in 0..1."""

from __future__ import annotations

import tomllib
from importlib import resources
from typing import Final

import numpy as np
from numpy.typing import NDArray
from scipy import signal

from bragi_analysis.dsp import features
from bragi_analysis.dsp.loudness import FLOOR_LUFS

type F64 = NDArray[np.float64]

HOP_SEC: Final = 0.5

#: Analysis rate of the spectral features (half the working rate).
FEATURE_RATE: Final = 24_000
N_FFT: Final = 1024
FRAME_HOP: Final = 512


def load_weights() -> dict[str, float]:
    """The tunable weights of ``config/energy.toml``."""
    text = resources.files("bragi_analysis").joinpath("config/energy.toml").read_text("utf-8")
    weights = tomllib.loads(text)["weights"]
    return {name: float(value) for name, value in weights.items()}


def _zscore(values: F64) -> F64:
    spread = float(np.std(values))
    if spread < 1e-9:
        return np.zeros_like(values)
    return (values - float(np.mean(values))) / spread


def combine(
    feature_values: dict[str, F64],
    weights: dict[str, float],
    silent: NDArray[np.bool_] | None = None,
) -> F64:
    """``sigmoid(sum w_i z_i)`` over the available features, weights renormalised.

    Features missing from ``feature_values`` (today ``active_stem_weight``) give up
    their weight to the rest, proportionally. Hops flagged ``silent`` are pinned to 0.
    """
    available = {name: weights[name] for name in feature_values if weights.get(name, 0.0) > 0.0}
    total = sum(available.values())
    if total <= 0.0:
        raise ValueError("no feature has a positive weight")
    count = len(next(iter(feature_values.values())))
    score = np.zeros(count)
    for name, weight in available.items():
        score += (weight / total) * _zscore(feature_values[name])
    energy = 1.0 / (1.0 + np.exp(-score))
    if silent is not None:
        energy = np.where(silent, 0.0, energy)
    return np.clip(energy, 0.0, 1.0)


def energy_curve(
    mono_48k: NDArray[np.floating],
    short_term_lufs: F64,
    sample_rate: int = 48_000,
    weights: dict[str, float] | None = None,
) -> F64:
    """The energy curve for a 48 kHz mono mix and its short-term loudness series.

    The result has ``len(short_term_lufs)`` values (``ceil(duration / 0.5 s)``).
    """
    count = short_term_lufs.shape[0]
    ratio = sample_rate // FEATURE_RATE
    x = signal.resample_poly(mono_48k.astype(np.float32), 1, ratio) if ratio > 1 else mono_48k

    magnitude = features.stft_magnitude(x, N_FFT, FRAME_HOP)
    times = np.arange(magnitude.shape[0]) * FRAME_HOP / FEATURE_RATE
    strength = features.onset_strength(magnitude)
    centroid = features.spectral_centroid_hz(magnitude, FEATURE_RATE, N_FFT)
    frame_power = (magnitude.astype(np.float64) ** 2).sum(axis=1)

    feature_values = {
        "loudness_st": short_term_lufs,
        "onset_density": features.onset_density_per_hop(strength, times, HOP_SEC, count),
        "spectral_centroid": features.per_hop(centroid, times, HOP_SEC, count, frame_power),
    }
    return combine(
        feature_values,
        weights if weights is not None else load_weights(),
        silent=short_term_lufs <= FLOOR_LUFS,
    )
