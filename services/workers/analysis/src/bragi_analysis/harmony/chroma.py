"""Pitch-class chroma and beat synchronisation (``specs/04`` §5.3).

The harmonic analysis stages work on a 12-dimensional pitch-class profile per
frame. Chroma is computed at a low rate because pitch classes, not timbre, are
what matter: resample to :data:`CHROMA_RATE`, fold every STFT bin in
``[F_MIN_HZ, F_MAX_HZ]`` into its nearest pitch class, and L2-normalise each
frame. :func:`beat_sync` averages the frames of each beat interval so chord
segments can land on beat boundaries.

No model weights and no I/O: everything here takes and returns NumPy arrays, so
it is unit-tested directly.
"""

from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction

import numpy as np
from numpy.typing import NDArray
from scipy.signal import resample_poly

from bragi_analysis.dsp.features import stft_magnitude

#: Working rate of the chroma front end. Low enough to be cheap, high enough to
#: resolve the bass region after folding.
CHROMA_RATE = 11_025
#: STFT window and hop (hop ≈ 0.093 s at :data:`CHROMA_RATE`).
N_FFT = 4096
HOP = 1024
#: Bins below this are sub-bass rumble; above it, mostly bright harmonics.
F_MIN_HZ = 65.0
F_MAX_HZ = 2100.0
#: Equal-temperament reference.
A4_HZ = 440.0
#: Sharps only: the spelling the key and chord roots use.
NOTE_NAMES: tuple[str, ...] = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")

type F32 = NDArray[np.float32]
type F64 = NDArray[np.float64]


@dataclass(frozen=True)
class ChromaFrames:
    """Chroma on a time grid, plus the raw band energy used for silence tests."""

    #: Segment boundaries in seconds, shape ``(n + 1,)``; frame ``i`` is
    #: ``[edges[i], edges[i + 1])``.
    edges: F64
    #: Per-frame chroma, shape ``(n, 12)``; L2-normalised, zero for silent frames.
    vectors: F32
    #: Sum of the folded magnitudes per frame, shape ``(n,)``.
    energy: F64

    @property
    def frame_centres(self) -> F64:
        """The centre time of every frame, shape ``(n,)``."""
        return np.asarray(0.5 * (self.edges[:-1] + self.edges[1:]), dtype=np.float64)


def resample_mono(mono: NDArray[np.floating], from_rate: int, to_rate: int = CHROMA_RATE) -> F32:
    """Resamples a mono signal with a polyphase Kaiser filter (exact rational ratio)."""
    if from_rate == to_rate:
        return np.asarray(mono, dtype=np.float32)
    ratio = Fraction(to_rate, from_rate)
    out = resample_poly(
        np.asarray(mono, dtype=np.float64),
        ratio.numerator,
        ratio.denominator,
        window=("kaiser", 9.0),
    )
    return np.asarray(out, dtype=np.float32)


def _pitch_class_map(sample_rate: int) -> tuple[NDArray[np.bool_], NDArray[np.int64]]:
    """The ``(valid, pitch_class)`` arrays for every FFT bin at ``sample_rate``."""
    freqs = np.fft.rfftfreq(N_FFT, 1.0 / sample_rate)
    with np.errstate(divide="ignore"):
        midi = 69.0 + 12.0 * np.log2(np.maximum(freqs, 1e-9) / A4_HZ)
        pc = np.mod(np.floor(midi + 0.5), 12.0)
    valid = (freqs >= F_MIN_HZ) & (freqs <= F_MAX_HZ) & np.isfinite(midi)
    return np.asarray(valid), np.asarray(pc, dtype=np.int64)


def _frame_edges(times: F64, hop_sec: float) -> F64:
    """Boundaries around frame centres: ``[t0 - h/2, t0 + h/2, t1 + h/2, …]``."""
    if times.size == 0:
        return np.zeros(1, dtype=np.float64)
    edges = np.concatenate([[times[0] - 0.5 * hop_sec], times + 0.5 * hop_sec])
    return np.asarray(np.maximum(edges, 0.0), dtype=np.float64)


def chroma_frames(mono: NDArray[np.floating], sample_rate: int) -> ChromaFrames:
    """Pitch-class chroma of a mono signal, one (normalised) vector per STFT frame."""
    audio = resample_mono(mono, sample_rate)
    magnitude = stft_magnitude(audio, N_FFT, HOP)
    valid, pitch_class = _pitch_class_map(CHROMA_RATE)
    band = magnitude[:, valid]
    one_hot = np.zeros((band.shape[1], 12), dtype=np.float32)
    if band.shape[1]:
        one_hot[np.arange(band.shape[1]), pitch_class[valid]] = 1.0
    raw = band @ one_hot
    norms = np.linalg.norm(raw, axis=1, keepdims=True)
    vectors = np.divide(raw, norms, out=np.zeros_like(raw), where=norms > 1e-9)
    hop_sec = HOP / CHROMA_RATE
    times = np.arange(vectors.shape[0], dtype=np.float64) * hop_sec
    energy = np.asarray(band.sum(axis=1), dtype=np.float64)
    return ChromaFrames(edges=_frame_edges(times, hop_sec), vectors=vectors, energy=energy)


def beat_sync(
    chroma: ChromaFrames, beats: NDArray[np.floating], duration_sec: float
) -> ChromaFrames:
    """Averages the frames of each beat interval (04 §5.3: beat-synchronous chroma).

    The first interval starts at 0 and the last ends at ``duration_sec``, so the
    whole song is covered. With fewer than one usable beat the input is returned
    unchanged (the caller then decodes on the frame grid).
    """
    interior = np.unique(np.asarray(beats, dtype=np.float64))
    interior = interior[(interior > 0.0) & (interior < duration_sec)]
    if interior.size == 0 or duration_sec <= 0.0:
        return chroma
    edges = np.concatenate([[0.0], interior, [duration_sec]])
    count = edges.size - 1
    index = np.clip(np.searchsorted(edges, chroma.frame_centres, side="right") - 1, 0, count - 1)
    weight = chroma.energy
    sums = np.zeros((count, 12), dtype=np.float64)
    for pitch in range(12):
        sums[:, pitch] = np.bincount(
            index, weights=chroma.vectors[:, pitch] * weight, minlength=count
        )
    mass = np.bincount(index, weights=weight, minlength=count)
    members = np.bincount(index, minlength=count).astype(np.float64)
    averaged = sums / np.maximum(mass, 1e-12)[:, None]
    norms = np.linalg.norm(averaged, axis=1, keepdims=True)
    vectors = np.divide(averaged, norms, out=np.zeros_like(averaged), where=norms > 1e-9)
    energy = mass / np.maximum(members, 1.0)
    return ChromaFrames(
        edges=np.asarray(edges, dtype=np.float64),
        vectors=np.asarray(vectors, dtype=np.float32),
        energy=np.asarray(energy, dtype=np.float64),
    )
