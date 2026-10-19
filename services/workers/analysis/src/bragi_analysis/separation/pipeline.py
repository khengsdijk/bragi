"""The numeric core of stem separation (``specs/04`` §4): no torch, no I/O.

Everything that has to be *right* regardless of the model lives here so it can be
tested with a stub backend: the chunk plan, the linear crossfade, resampling, the
silent-stem drop and the residual. The model itself sits behind
:class:`SeparationBackend` (see ``demucs_backend``).

Conventions: audio is ``(channels, samples)``; stems are ``(stems, channels, samples)``.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass, field
from fractions import Fraction
from typing import Protocol

import numpy as np
from numpy.typing import NDArray
from scipy.signal import resample_poly

#: The project and working-asset sample rate (02 §2, 04 §3.1).
WORKING_RATE = 48_000
#: Stems quieter than this over the whole song are dropped (04 §4).
SILENCE_FLOOR_DB = -60.0
#: The largest 24-bit sample value, as a float (FLAC is stored as k / 2^23).
FULL_SCALE_24 = 1.0 - 2.0**-23

Audio = NDArray[np.floating]
Stems = NDArray[np.float32]


class SeparationBackend(Protocol):
    """What the pipeline needs from a model; implemented by ``DemucsBackend`` and by test stubs."""

    @property
    def sample_rate(self) -> int:
        """The rate the model works at (HTDemucs: 44 100 Hz)."""
        ...

    @property
    def stem_names(self) -> Sequence[str]:
        """Stem names in output order, e.g. ``drums, bass, other, vocals, guitar, piano``."""
        ...

    @property
    def max_segment_sec(self) -> float:
        """The longest chunk the model accepts (HTDemucs: 7.8 s)."""
        ...

    def separate(self, chunk: NDArray[np.float32]) -> NDArray[np.float32]:
        """Separates a ``(channels, n)`` chunk at ``sample_rate`` into ``(stems, channels, n)``."""
        ...


@dataclass(frozen=True)
class Chunk:
    """A half-open sample range ``[start, end)`` of the (model-rate) mix."""

    start: int
    end: int

    @property
    def length(self) -> int:
        """Samples in the chunk."""
        return self.end - self.start


def resample(audio: NDArray[np.floating], from_rate: int, to_rate: int) -> NDArray[np.floating]:
    """Resamples ``(channels, n)`` audio with a polyphase Kaiser filter (exact rational ratio)."""
    if from_rate == to_rate:
        return audio
    ratio = Fraction(to_rate, from_rate)
    out = resample_poly(audio, ratio.numerator, ratio.denominator, axis=-1, window=("kaiser", 9.0))
    return np.asarray(out)


def fit_length(audio: NDArray[np.floating], length: int) -> NDArray[np.floating]:
    """Trims or zero-pads the last axis to exactly ``length`` samples."""
    n = audio.shape[-1]
    if n == length:
        return audio
    if n > length:
        return audio[..., :length]
    pad = [(0, 0)] * (audio.ndim - 1) + [(0, length - n)]
    return np.pad(audio, pad)


def plan_chunks(total: int, segment: int, overlap: int) -> list[Chunk]:
    """Plans overlapping chunks that cover ``[0, total)``.

    Chunks start every ``segment - overlap`` samples. The last chunk is anchored to
    the end of the signal and, when that leaves it shorter than a full segment, it is
    moved back so every chunk (except for a signal shorter than one segment) is full
    length; the extra overlap with its predecessor is handled by :class:`Stitcher`.
    """
    if segment <= overlap or overlap < 0:
        raise ValueError("segment must be longer than overlap, and overlap non-negative")
    if total <= segment:
        return [Chunk(0, total)]
    step = segment - overlap
    chunks: list[Chunk] = []
    start = 0
    while True:
        end = start + segment
        if end >= total:
            chunks.append(Chunk(max(0, total - segment), total))
            return chunks
        chunks.append(Chunk(start, end))
        start += step


class Stitcher:
    """Overlap-adds chunk outputs with a linear crossfade.

    Each chunk gets a weight that ramps linearly up across its overlap with the
    previous chunk and down across its overlap with the next; the accumulated signal
    is divided by the accumulated weight, so the weights sum to exactly one at every
    sample and an identity model reproduces its input exactly.
    """

    def __init__(self, stems: int, channels: int, total: int, chunks: Sequence[Chunk]) -> None:
        """Allocates the accumulators for ``total`` samples and the planned ``chunks``."""
        self._chunks = list(chunks)
        self._acc = np.zeros((stems, channels, total), dtype=np.float32)
        self._weight = np.zeros(total, dtype=np.float32)
        self._added = 0

    def add(self, index: int, output: NDArray[np.float32]) -> None:
        """Adds the model output for chunk ``index`` (``(stems, channels, chunk length)``)."""
        chunk = self._chunks[index]
        if output.shape[-1] != chunk.length:
            raise ValueError(
                f"chunk {index}: expected {chunk.length} samples, got {output.shape[-1]}"
            )
        weight = np.ones(chunk.length, dtype=np.float32)
        if index > 0:
            overlap = self._chunks[index - 1].end - chunk.start
            if overlap > 0:
                weight[:overlap] = _ramp(overlap)
        if index < len(self._chunks) - 1:
            overlap = chunk.end - self._chunks[index + 1].start
            if overlap > 0:
                weight[chunk.length - overlap :] *= _ramp(overlap)[::-1]
        self._acc[:, :, chunk.start : chunk.end] += output * weight
        self._weight[chunk.start : chunk.end] += weight
        self._added += 1

    def finish(self) -> Stems:
        """Returns the stitched stems; every chunk must have been added."""
        if self._added != len(self._chunks):
            raise ValueError(f"{self._added} of {len(self._chunks)} chunks were added")
        weight = np.maximum(self._weight, np.finfo(np.float32).tiny)
        self._acc /= weight
        return self._acc


def _ramp(length: int) -> NDArray[np.float32]:
    """Rising linear ramp strictly inside (0, 1): ``(i + 1) / (length + 1)``."""
    return (np.arange(1, length + 1, dtype=np.float32)) / np.float32(length + 1)


def rms_db(audio: NDArray[np.floating]) -> float:
    """Whole-signal RMS over all channels, in dBFS (``-inf`` for digital silence)."""
    if audio.size == 0:
        return -math.inf
    power = float(np.mean(np.square(audio, dtype=np.float64)))
    return -math.inf if power <= 0.0 else 10.0 * math.log10(power)


def peak_db(audio: NDArray[np.floating]) -> float:
    """Sample peak in dBFS."""
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    return -math.inf if peak <= 0.0 else 20.0 * math.log10(peak)


def clip_full_scale(audio: NDArray[np.floating]) -> NDArray[np.floating]:
    """Clips to what 24-bit FLAC can hold; a separated stem can overshoot ±1."""
    return np.asarray(np.clip(audio, -1.0, FULL_SCALE_24))


@dataclass
class StemOutcome:
    """The decision for one stem: kept (with its measured level) or dropped as silent."""

    name: str
    rms_db: float
    kept: bool


@dataclass
class ResidualAccumulator:
    """Builds ``residual = mix - Σ kept stems`` from the stems *as stored*.

    Feed it the decoded stem files (not the float model output): the residual is then the
    exact complement of what is on disk, 24-bit quantisation included. A stem that was
    dropped as silent is never added, so its sub-floor content lands in the residual and
    ``Σ stems + residual`` still equals the mix.
    """

    mix: Audio
    outcomes: list[StemOutcome] = field(default_factory=list)

    def __post_init__(self) -> None:
        """Starts the running sum at silence."""
        self._sum = np.zeros_like(self.mix)

    def add(self, stored_stem: Audio) -> None:
        """Adds a kept stem exactly as it was stored."""
        self._sum += stored_stem

    def residual(self) -> Audio:
        """``mix - sum(stored stems)``; the caller clips it to the FLAC range."""
        return np.asarray(self.mix - self._sum)


def null_db(mix: Audio, stems: Sequence[Audio], residual: Audio) -> tuple[float, float]:
    """``(rms, peak)`` of ``mix - sum(stems) - residual`` in dBFS (the WP-1.3 acceptance)."""
    error = mix - residual
    for stem in stems:
        error = error - stem
    return rms_db(error), peak_db(error)
