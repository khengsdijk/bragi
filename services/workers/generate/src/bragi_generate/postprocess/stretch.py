"""Dependency-free time stretching (WSOLA) and the semitone pitch shift.

The engine's Rust stretcher (``bragi-dsp::stretch``) is not reachable from
Python, and the spec's "resampling-free" hint rules out the naive
resample-and-play-faster trick for tempo, so this is Waveform-Similarity
Overlap-Add (WSOLA, Verhelst & Roelands 1993):

- synthesis frames of 2048 samples (≈ 43 ms at 48 kHz) are laid down every 1024
  samples (50 % Hann overlap);
- the analysis position advances by ``hop / factor`` so the output length is
  ``factor`` times the input length;
- each frame is searched within ±256 samples (≈ ±5 ms) around its ideal position
  for the segment that best continues the previous frame, which is what keeps
  transients from being split and doubled.

The frame decision is made on the mono mix and applied to every channel, so the
stereo image is untouched. Overlap-add is normalised by the accumulated window,
which makes a factor of exactly 1 reconstruct the input (bit-identical up to
float32 rounding) and avoids level ripple at every factor.

Pitch shifting multiplies the pitch by ``2**(semitones / 12)`` without changing
the duration: stretch by that ratio, then resample back to the original length.
It is only used for the ±1 semitone repair of 09 §6 step 3, so the artefact of
this simple method is acceptable.
"""

from __future__ import annotations

import numpy as np
from numpy.typing import NDArray
from scipy import signal

type F32 = NDArray[np.float32]

#: Frame geometry at 48 kHz; scaled for other rates.
REFERENCE_RATE = 48_000
FRAME = 2_048
SYNTHESIS_HOP = FRAME // 2
TOLERANCE = 256


def _geometry(sample_rate: int) -> tuple[int, int, int]:
    scale = sample_rate / REFERENCE_RATE
    frame = max(64, round(FRAME * scale))
    hop = max(32, round(SYNTHESIS_HOP * scale))
    tolerance = max(8, round(TOLERANCE * scale))
    return frame, hop, tolerance


def time_stretch(samples: F32, factor: float, sample_rate: int) -> F32:
    """WSOLA: ``factor`` > 1 lengthens, < 1 shortens, pitch unchanged."""
    if factor <= 0.0:
        raise ValueError(f"stretch factor must be positive, got {factor}")
    frames = samples.shape[0]
    if frames == 0 or abs(factor - 1.0) < 1e-4:
        return np.ascontiguousarray(samples, dtype=np.float32)

    frame, hop, tolerance = _geometry(sample_rate)
    mono = np.asarray(samples.mean(axis=1), dtype=np.float32)
    out_frames = max(frame, round(frames * factor))
    count = (out_frames - frame) // hop + 2
    analysis_hop = hop / factor

    # Two frames of padding on each side keeps every window inside the array.
    pad = frame + hop
    padded = np.pad(mono, (pad, pad + frame))
    multichannel = np.pad(samples, ((pad, pad + frame), (0, 0)))
    window = np.hanning(frame + 1)[:-1].astype(np.float32)

    output = np.zeros((count * hop + frame, samples.shape[1]), dtype=np.float64)
    weights = np.zeros(output.shape[0], dtype=np.float64)
    previous = 0
    for index in range(count):
        ideal = pad + round(index * analysis_hop)
        if index == 0:
            position = ideal
        else:
            low = max(0, ideal - tolerance)
            high = min(padded.shape[0] - frame, ideal + tolerance)
            if high <= low:
                position = max(0, min(ideal, padded.shape[0] - frame))
            else:
                target = padded[previous + hop : previous + frame]
                search = padded[low + hop : high + frame]
                scores = np.correlate(search, target, mode="valid")
                position = low + int(np.argmax(scores))
        start = index * hop
        output[start : start + frame] += multichannel[position : position + frame] * window[:, None]
        weights[start : start + frame] += window
        previous = position

    result = output / np.maximum(weights, 1e-6)[:, None]
    trimmed = np.ascontiguousarray(result[:out_frames], dtype=np.float32)
    return _fade_edges(trimmed, min(hop, trimmed.shape[0] // 2))


def pitch_shift(samples: F32, semitones: float, sample_rate: int) -> F32:
    """Pitch shift by stretching with the ratio, then resampling back to the same length."""
    if abs(semitones) < 1e-9:
        return np.ascontiguousarray(samples, dtype=np.float32)
    ratio = float(2.0 ** (semitones / 12.0))
    stretched = time_stretch(samples, ratio, sample_rate)
    if stretched.shape[0] < 2:
        return np.ascontiguousarray(samples, dtype=np.float32)
    resampled = signal.resample(stretched, samples.shape[0], axis=0)
    return np.ascontiguousarray(np.asarray(resampled, dtype=np.float32))


def _fade_edges(samples: F32, length: int) -> F32:
    """A short cosine fade at both ends, hiding the window's zero-weight edge."""
    if length <= 0 or samples.shape[0] < 2 * length:
        return np.ascontiguousarray(samples)
    ramp = np.sin(np.linspace(0.0, np.pi / 2.0, length))[:, None].astype(np.float32)
    out = samples.copy()
    out[:length] *= ramp
    out[-length:] *= ramp[::-1]
    return out
