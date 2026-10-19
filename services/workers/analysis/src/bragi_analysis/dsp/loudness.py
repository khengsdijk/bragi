"""ITU-R BS.1770-4 / EBU R128 loudness (``specs/04`` §5.5).

Integrated loudness, loudness range (EBU Tech 3342), true peak (4x oversampled)
and a short-term series. Implemented directly on NumPy/SciPy so that all four
numbers share one K-weighted signal. The coefficients are the ones printed in
BS.1770-4 for 48 kHz, which is the working-asset rate (02 §2.2).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray
from scipy import signal

SAMPLE_RATE = 48_000

#: Loudness below this is silence; JSON has no -inf, so every value is floored here.
FLOOR_LUFS = -70.0
#: Floor for the true-peak figure of digital silence.
FLOOR_DB = -150.0

#: BS.1770-4 stage 1 (high-shelf) and stage 2 (RLB high-pass) at 48 kHz.
_SHELF_B = [1.53512485958697, -2.69169618940638, 1.19839281085285]
_SHELF_A = [1.0, -1.69065929318241, 0.73248077421585]
_RLB_B = [1.0, -2.0, 1.0]
_RLB_A = [1.0, -1.99004745483398, 0.99007225036621]

_OFFSET_DB = -0.691

type F64 = NDArray[np.float64]


@dataclass(frozen=True)
class Loudness:
    """The numbers of 04 §5.5, before they are put in a blob."""

    integrated_lufs: float
    lra: float
    true_peak_db: float
    short_term_lufs: F64


def k_weighted_power(pcm: NDArray[np.floating]) -> F64:
    """Per-sample ``sum_ch y_ch^2`` of the K-weighted signal (channel weights all 1.0)."""
    power: F64 = np.zeros(pcm.shape[0], dtype=np.float64)
    for channel in range(pcm.shape[1]):
        x = pcm[:, channel].astype(np.float64)
        y = signal.lfilter(_RLB_B, _RLB_A, signal.lfilter(_SHELF_B, _SHELF_A, x))
        power += y * y
    return power


def _lufs(mean_square: F64 | float) -> F64:
    with np.errstate(divide="ignore"):
        return np.asarray(_OFFSET_DB + 10.0 * np.log10(mean_square))


def _relative_threshold(block_ms: F64, relative_lu: float) -> float | None:
    """The relative gate: the absolute-gated power mean plus ``relative_lu``."""
    absolute = block_ms[_lufs(block_ms) > FLOOR_LUFS]
    if absolute.size == 0:
        return None
    return float(_lufs(float(absolute.mean()))) + relative_lu


def _gated_loudness(block_ms: F64, relative_lu: float) -> float | None:
    """BS.1770 two-stage gated loudness of block mean-squares; ``None`` if nothing passes."""
    threshold = _relative_threshold(block_ms, relative_lu)
    if threshold is None:
        return None
    relative = block_ms[_lufs(block_ms) > threshold]
    if relative.size == 0:
        return None
    return float(_lufs(float(relative.mean())))


def _blocks(cumulative: F64, size: int, hop: int) -> F64:
    """Mean-square of every full ``size`` window at ``hop`` spacing."""
    total = cumulative.size - 1
    if total < size:
        return np.asarray([(cumulative[-1] - cumulative[0]) / max(total, 1)])
    starts = np.arange(0, total - size + 1, hop)
    return np.asarray((cumulative[starts + size] - cumulative[starts]) / size)


def short_term_series(power: F64, hop_sec: float, sample_rate: int = SAMPLE_RATE) -> F64:
    """3 s short-term loudness, one value per hop, centred on the hop and edge-truncated.

    Value ``i`` covers ``[(i + 0.5) * hop - 1.5 s, (i + 0.5) * hop + 1.5 s]`` clipped to
    the file, so the series has ``ceil(duration / hop)`` entries and lines up with
    the energy curve (04 §5.5). Clamped at ``FLOOR_LUFS``.
    """
    total = power.shape[0]
    count = max(1, -(-total // round(hop_sec * sample_rate)))
    cumulative = np.concatenate([[0.0], np.cumsum(power)])
    centre = (np.arange(count) + 0.5) * hop_sec * sample_rate
    half = 1.5 * sample_rate
    start = np.clip(np.floor(centre - half), 0, total).astype(np.int64)
    end = np.clip(np.ceil(centre + half), 0, total).astype(np.int64)
    end = np.maximum(end, np.minimum(start + 1, total))
    length = np.maximum(end - start, 1)
    mean_square = (cumulative[end] - cumulative[start]) / length
    return np.maximum(_lufs(mean_square), FLOOR_LUFS)


def true_peak_db(pcm: NDArray[np.floating], sample_rate: int = SAMPLE_RATE) -> float:
    """True peak in dBTP: the sample peak of the 4x oversampled signal (BS.1770-4 Annex 2)."""
    segment = 30 * sample_rate
    pad = 2048
    peak = 0.0
    total = pcm.shape[0]
    for channel in range(pcm.shape[1]):
        x = pcm[:, channel].astype(np.float32)
        for start in range(0, total, segment):
            lo = max(0, start - pad)
            hi = min(total, start + segment + pad)
            up = signal.resample_poly(x[lo:hi], 4, 1)
            inner = up[4 * (start - lo) : 4 * (min(total, start + segment) - lo)]
            if inner.size:
                peak = max(peak, float(np.max(np.abs(inner))))
    if peak <= 0.0:
        return FLOOR_DB
    return max(20.0 * float(np.log10(peak)), FLOOR_DB)


def measure(
    pcm: NDArray[np.floating], hop_sec: float = 0.5, sample_rate: int = SAMPLE_RATE
) -> Loudness:
    """Integrated loudness, LRA, true peak and the short-term series of a 48 kHz signal."""
    if sample_rate != SAMPLE_RATE:
        raise ValueError(f"loudness is defined here for {SAMPLE_RATE} Hz, got {sample_rate}")
    power = k_weighted_power(pcm)
    cumulative = np.concatenate([[0.0], np.cumsum(power)])

    momentary = _blocks(cumulative, int(0.4 * sample_rate), int(0.1 * sample_rate))
    integrated = _gated_loudness(momentary, -10.0)

    # EBU Tech 3342: 3 s blocks, absolute gate -70 LUFS, relative gate -20 LU.
    short_blocks = _blocks(cumulative, 3 * sample_rate, int(0.1 * sample_rate))
    lra = 0.0
    threshold = _relative_threshold(short_blocks, -20.0)
    if threshold is not None:
        loudness = _lufs(short_blocks)
        kept = loudness[(loudness > FLOOR_LUFS) & (loudness > threshold)]
        if kept.size >= 2:
            lra = float(np.percentile(kept, 95) - np.percentile(kept, 10))

    return Loudness(
        integrated_lufs=FLOOR_LUFS if integrated is None else integrated,
        lra=max(lra, 0.0),
        true_peak_db=true_peak_db(pcm, sample_rate),
        short_term_lufs=short_term_series(power, hop_sec, sample_rate),
    )
