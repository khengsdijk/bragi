"""Beat-synchronous features for structure analysis (``specs/04`` §5.2).

Three views of the same audio, each averaged between consecutive beats:

* **chroma** (12 pitch classes): harmony, what a chorus repeats;
* **timbre** (log-mel DCT, coefficients 1..12): instrumentation and brightness;
* **energy** (RMS in dB): the dynamic contour, which separates a verse from a chorus.

The result is z-scored per column, weighted per block so no block dominates, and smoothed
over a few beats so the self-similarity matrix describes *phrases*, not single beats.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray
from scipy import fft as sp_fft
from scipy import ndimage

from bragi_analysis.dsp.features import stft_magnitude

type F64 = NDArray[np.float64]

N_FFT = 2048
HOP = 512
N_MELS = 40
N_TIMBRE = 12
#: Pitch range used for chroma (below this is rumble, above it is mostly noise).
CHROMA_MIN_HZ = 55.0
CHROMA_MAX_HZ = 4_000.0
#: Block weights in the feature vector (each block is scaled to unit total variance first).
WEIGHT_CHROMA = 1.0
WEIGHT_TIMBRE = 1.0
WEIGHT_ENERGY = 1.0
#: Beats averaged by the smoothing filter.
SMOOTH_BEATS = 4
SILENCE_DB = -80.0


@dataclass(frozen=True)
class BeatFeatures:
    """Per-beat features of one song."""

    #: ``(beats, dims)``, z-scored, block-weighted and smoothed.
    matrix: F64
    #: ``(beats,)`` mean RMS in dB per beat (raw, not z-scored).
    energy_db: F64


def _mel_filterbank(sample_rate: int) -> F64:
    def hz_to_mel(hz: F64) -> F64:
        return 2595.0 * np.log10(1.0 + hz / 700.0)

    def mel_to_hz(mel: F64) -> F64:
        return 700.0 * (10.0 ** (mel / 2595.0) - 1.0)

    freqs = np.fft.rfftfreq(N_FFT, 1.0 / sample_rate)
    edges = mel_to_hz(
        np.linspace(
            hz_to_mel(np.array([30.0]))[0], hz_to_mel(np.array([sample_rate / 2]))[0], N_MELS + 2
        )
    )
    bank = np.zeros((N_MELS, freqs.size))
    for m in range(N_MELS):
        lo, mid, hi = edges[m], edges[m + 1], edges[m + 2]
        up = (freqs - lo) / max(mid - lo, 1e-9)
        down = (hi - freqs) / max(hi - mid, 1e-9)
        bank[m] = np.maximum(0.0, np.minimum(up, down))
    return bank


def _chroma_map(sample_rate: int) -> F64:
    freqs = np.fft.rfftfreq(N_FFT, 1.0 / sample_rate)
    mapping = np.zeros((freqs.size, 12))
    for k, f in enumerate(freqs):
        if CHROMA_MIN_HZ <= f <= CHROMA_MAX_HZ:
            pitch = round(12 * np.log2(f / 440.0)) + 69
            mapping[k, pitch % 12] = 1.0
    return mapping


def _zscore(x: F64) -> F64:
    std = x.std(axis=0)
    return (x - x.mean(axis=0)) / np.where(std < 1e-9, 1.0, std)


def beat_features(mono: NDArray[np.floating], sample_rate: int, beats: F64) -> BeatFeatures:
    """Beat-synchronous features for ``beats`` (seconds, strictly increasing, >= 2 of them).

    Beat ``i`` covers ``[beats[i], beats[i + 1])``; the audio before the first beat belongs to
    beat 0 and the last beat extends to the end of the audio.
    """
    magnitude = stft_magnitude(mono, N_FFT, HOP).astype(np.float64)
    frame_times = np.arange(magnitude.shape[0]) * HOP / sample_rate
    power = magnitude**2

    chroma = np.log1p(100.0 * magnitude) @ _chroma_map(sample_rate)
    norm = np.linalg.norm(chroma, axis=1, keepdims=True)
    chroma = chroma / np.maximum(norm, 1e-9)

    mel = np.log(power @ _mel_filterbank(sample_rate).T + 1e-10)
    timbre = sp_fft.dct(mel, type=2, axis=1, norm="ortho")[:, 1 : N_TIMBRE + 1]

    rms_db = 10.0 * np.log10(power.mean(axis=1) * 2.0 + 1e-12)
    rms_db = np.maximum(rms_db, SILENCE_DB)

    # Frame -> beat index (frames before the first beat join beat 0).
    index = np.clip(np.searchsorted(beats, frame_times, side="right") - 1, 0, beats.size - 1)
    count = np.bincount(index, minlength=beats.size).astype(np.float64)
    safe = np.maximum(count, 1.0)[:, None]

    def pool(x: F64) -> F64:
        out = np.zeros((beats.size, x.shape[1]))
        np.add.at(out, index, x)
        out /= safe
        # A beat shorter than one frame inherits its predecessor.
        for i in map(int, np.flatnonzero(count == 0)):
            out[i] = out[i - 1] if i > 0 else out[1 % beats.size]
        return out

    chroma_b = pool(chroma)
    timbre_b = pool(timbre)
    energy_b = pool(rms_db[:, None])[:, 0]

    blocks = []
    for block, weight in (
        (chroma_b, WEIGHT_CHROMA),
        (timbre_b, WEIGHT_TIMBRE),
        (energy_b[:, None], WEIGHT_ENERGY),
    ):
        z = _zscore(block)
        blocks.append(z * weight / np.sqrt(block.shape[1]))
    matrix = np.concatenate(blocks, axis=1)
    matrix = ndimage.uniform_filter1d(matrix, size=SMOOTH_BEATS, axis=0, mode="nearest")
    return BeatFeatures(matrix=matrix, energy_db=energy_b)
