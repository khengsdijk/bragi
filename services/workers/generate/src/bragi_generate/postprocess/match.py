"""Step 6 of 09 §6: loudness and spectral match against the context.

Loudness is EBU R128 again, from the analysis worker's K-weighted power
(``bragi_analysis.dsp.loudness``), measured over 2 s windows. Only a side that
touches context is matched: the head always (it joins the song), the tail only when
context follows it (an inpaint's right side, passed as ``after``); between the two
the gain is ramped linearly in dB. Without ``after`` the whole clip gets the head's
gain, so a model's own fade-out is kept instead of boosted. The gain is lowered as a
whole when it would push the peak above ``PEAK_CEILING`` (-1 dBFS), so a matched
candidate never clips.

The spectral match is the 31-band 1/3-octave comparison of 03 §8.2 expressed as
``match_eq`` parameters: per-band ``context - candidate`` in dB, clamped to
±6 dB. The EQ is returned, never applied: the engine owns the fx and the caller
attaches it to the clip so the user can see and undo it.
"""

from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction

import numpy as np
from numpy.typing import NDArray
from scipy import signal

from bragi_analysis.dsp.features import stft_magnitude
from bragi_analysis.dsp.loudness import FLOOR_LUFS, SAMPLE_RATE, k_weighted_power
from bragi_generate.postprocess.config import GateConfig
from bragi_generate.postprocess.types import Audio, MatchEq

type F32 = NDArray[np.float32]
type F64 = NDArray[np.float64]

#: BS.1770-4 loudness offset; the analysis worker applies the same constant.
LUFS_OFFSET_DB = -0.691
#: STFT for the 31-band comparison: ≈ 5.9 Hz bins at 48 kHz.
EQ_N_FFT = 8_192
EQ_HOP = 4_096
#: First band centre and the spacing between the 31 ISO third-octave centres.
EQ_FIRST_HZ = 20.0
EQ_BAND_RATIO = 10.0**0.1
#: Below this a band has no usable level and gets no correction.
EQ_FLOOR_DB = -120.0
#: The loudest a matched candidate may peak: -1 dBFS, ACE-Step's own normalisation level.
PEAK_CEILING = 10.0 ** (-1.0 / 20.0)


@dataclass(frozen=True)
class GainMatch:
    """The applied ramp and the levels it was computed from."""

    audio: Audio
    target_lufs: float
    head_lufs: float
    tail_lufs: float
    head_gain_db: float
    tail_gain_db: float


def _to_48k(samples: F32, sample_rate: int) -> F32:
    if sample_rate == SAMPLE_RATE:
        return samples
    ratio = Fraction(SAMPLE_RATE, sample_rate).limit_denominator(1000)
    out = signal.resample_poly(
        samples.astype(np.float64), ratio.numerator, ratio.denominator, axis=0
    )
    return np.ascontiguousarray(out, dtype=np.float32)


def weighted_power(samples: F32, sample_rate: int) -> F64:
    """Per-sample K-weighted power at 48 kHz, the input of every LUFS value here."""
    return k_weighted_power(_to_48k(samples, sample_rate))


def lufs(power: F64, start: int = 0, end: int | None = None) -> float:
    """LUFS of a K-weighted power slice (a plain mean, i.e. no gating)."""
    segment = power[start:end]
    if segment.size == 0:
        return FLOOR_LUFS
    mean_square = float(segment.mean())
    if mean_square <= 1e-12:
        return FLOOR_LUFS
    return max(LUFS_OFFSET_DB + 10.0 * float(np.log10(mean_square)), FLOOR_LUFS)


def measure(audio: Audio) -> float:
    """LUFS of a whole clip."""
    return lufs(weighted_power(audio.samples, audio.sample_rate))


def loudness_match(
    clip: Audio, context: Audio, cfg: GateConfig, *, after: Audio | None = None
) -> GainMatch:
    """Matches the clip's head to ``context`` and, given ``after``, its tail to that."""
    window = max(1, round(cfg.loudness_window_sec * clip.sample_rate))
    limit = cfg.loudness_max_gain_db

    context_power = weighted_power(context.samples, context.sample_rate)
    context_window = min(window, context_power.size)
    target = lufs(context_power, context_power.size - context_window, context_power.size)

    power = weighted_power(clip.samples, clip.sample_rate)
    head = lufs(power, 0, min(window, power.size))
    tail = lufs(power, max(0, power.size - window), power.size)
    head_gain = float(np.clip(target - head, -limit, limit))
    tail_gain = head_gain
    if after is not None:
        after_power = weighted_power(after.samples, after.sample_rate)
        after_target = lufs(after_power, 0, min(window, after_power.size))
        tail_gain = float(np.clip(after_target - tail, -limit, limit))

    ramp_db = np.linspace(head_gain, tail_gain, clip.frames, dtype=np.float64)
    gain = np.asarray(10.0 ** (ramp_db / 20.0), dtype=np.float32)[:, None]
    boosted = np.ascontiguousarray(clip.samples * gain, dtype=np.float32)
    peak = float(np.max(np.abs(boosted))) if boosted.size else 0.0
    if peak > PEAK_CEILING:
        # Lower the whole ramp rather than limit: the shape (and the head match) is kept as
        # closely as the headroom allows, and nothing is distorted.
        trim_db = 20.0 * float(np.log10(PEAK_CEILING / peak))
        head_gain += trim_db
        tail_gain += trim_db
        boosted = np.ascontiguousarray(boosted * np.float32(PEAK_CEILING / peak), dtype=np.float32)
    return GainMatch(
        audio=Audio(boosted, clip.sample_rate),
        target_lufs=target,
        head_lufs=head,
        tail_lufs=tail,
        head_gain_db=head_gain,
        tail_gain_db=tail_gain,
    )


def band_centres(count: int) -> F64:
    """The ``count`` ISO third-octave centres, 20 Hz upwards."""
    return np.asarray([EQ_FIRST_HZ * EQ_BAND_RATIO**index for index in range(count)], np.float64)


def band_levels(audio: Audio, count: int) -> tuple[F64, F64]:
    """Mean per-band level in dB and the band centres, 1/3-octave bands."""
    magnitude = stft_magnitude(audio.mono, EQ_N_FFT, EQ_HOP)
    power = np.asarray(np.mean(magnitude.astype(np.float64) ** 2, axis=0), dtype=np.float64)
    freqs = np.fft.rfftfreq(EQ_N_FFT, 1.0 / audio.sample_rate)
    centres = band_centres(count)
    half = EQ_BAND_RATIO**0.5
    levels = np.full(count, EQ_FLOOR_DB, dtype=np.float64)
    for index, centre in enumerate(centres):
        mask = (freqs >= centre / half) & (freqs < centre * half)
        if not np.any(mask):
            if centre * half <= freqs[-1]:
                nearest = int(np.argmin(np.abs(freqs - centre)))
                levels[index] = 10.0 * float(np.log10(max(power[nearest], 1e-30)))
            continue
        levels[index] = 10.0 * float(np.log10(max(float(power[mask].mean()), 1e-30)))
    return levels, centres


def spectral_match(clip: Audio, context: Audio, cfg: GateConfig) -> MatchEq:
    """The ``match_eq`` bands that tilt the clip's spectrum toward the context's."""
    clip_levels, centres = band_levels(clip, cfg.eq_bands)
    context_levels, _ = band_levels(context, cfg.eq_bands)
    nyquist = clip.sample_rate / 2.0
    bands: list[float] = []
    for index in range(cfg.eq_bands):
        if centres[index] >= nyquist:
            bands.append(0.0)
            continue
        if clip_levels[index] <= EQ_FLOOR_DB or context_levels[index] <= EQ_FLOOR_DB:
            bands.append(0.0)
            continue
        correction = float(
            np.clip(context_levels[index] - clip_levels[index], -cfg.eq_max_db, cfg.eq_max_db)
        )
        bands.append(round(correction, 2))
    return MatchEq(bands=tuple(bands), amount=1.0)
