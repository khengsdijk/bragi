"""Value types of the generation quality gates (``specs/09-generation.md`` §6).

Everything is a frozen dataclass over NumPy arrays, so a gate result can be
serialised, compared for determinism and passed between the gate modules without
copying conventions. Audio is float32 and stereo (or any channel count ≥ 1):
the engine renders 48 kHz, and arbitrary rates are resampled only where a
sub-algorithm needs its own rate.
"""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Literal

import numpy as np
from numpy.typing import NDArray

type F32 = NDArray[np.float32]
type MetricValue = float | int | str | bool
type Direction = Literal["forward", "backward"]
type Mode = Literal["major", "minor"]

#: Sharps only, matching ``bragi_analysis.harmony.chroma.NOTE_NAMES``.
NOTE_NAMES: tuple[str, ...] = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
#: Flat spellings a caller may send for the same pitch classes.
_FLAT_NAMES: dict[str, int] = {"Db": 1, "Eb": 3, "Gb": 6, "Ab": 8, "Bb": 10}

#: A key is "relative" of another when the tonics differ by these semitones.
RELATIVE_MAJOR_TO_MINOR = 9
RELATIVE_MINOR_TO_MAJOR = 3


@dataclass(frozen=True)
class Audio:
    """Float32 PCM, shape ``(frames, channels)``, plus its sample rate."""

    samples: F32
    sample_rate: int

    def __post_init__(self) -> None:
        """Validates the shape, dtype and rate once, at construction."""
        if self.samples.ndim != 2 or self.samples.shape[1] < 1:
            raise ValueError(f"expected (frames, channels) audio, got {self.samples.shape}")
        if self.samples.dtype != np.float32:
            raise ValueError(f"expected float32 audio, got {self.samples.dtype}")
        if self.sample_rate <= 0:
            raise ValueError(f"sample rate must be positive, got {self.sample_rate}")

    @property
    def frames(self) -> int:
        """Number of sample frames."""
        return int(self.samples.shape[0])

    @property
    def duration_sec(self) -> float:
        """Length in seconds."""
        return self.frames / self.sample_rate

    @property
    def mono(self) -> F32:
        """Channel mean, which every analysis stage works on."""
        return np.ascontiguousarray(np.asarray(self.samples.mean(axis=1), dtype=np.float32))

    def reversed(self) -> Audio:
        """The same audio played backwards (used to mirror the backward direction)."""
        return Audio(np.ascontiguousarray(self.samples[::-1]), self.sample_rate)

    def trimmed(self, start: int, end: int | None = None) -> Audio:
        """Samples ``[start, end)``."""
        return Audio(np.ascontiguousarray(self.samples[start:end]), self.sample_rate)


@dataclass(frozen=True)
class KeySpec:
    """A pitch class plus mode: the two fields the schemas store."""

    tonic_pc: int
    mode: Mode

    def __post_init__(self) -> None:
        """A pitch class is 0..11; a mode is checked by the type."""
        if not 0 <= self.tonic_pc < 12:
            raise ValueError(f"tonic_pc must be 0..11, got {self.tonic_pc}")

    @property
    def label(self) -> str:
        """``"C major"``, for logs and metrics."""
        return f"{NOTE_NAMES[self.tonic_pc]} {self.mode}"

    @classmethod
    def parse(cls, tonic: str, mode: str) -> KeySpec:
        """From the schema spellings (``"F#"``/``"Gb"``, ``"major"``/``"minor"``)."""
        if tonic in NOTE_NAMES:
            tonic_pc = NOTE_NAMES.index(tonic)
        elif tonic in _FLAT_NAMES:
            tonic_pc = _FLAT_NAMES[tonic]
        else:
            raise ValueError(f"unknown tonic {tonic!r}")
        if mode == "major":
            return cls(tonic_pc, "major")
        if mode == "minor":
            return cls(tonic_pc, "minor")
        raise ValueError(f"mode must be major or minor, got {mode!r}")


@dataclass(frozen=True)
class GateRequest:
    """The musical facts a candidate is conformed to (09 §2.1, §4.2)."""

    bpm: float
    time_signature: tuple[int, int]
    key: KeySpec
    bars: int
    overlap_bars: int = 2
    direction: Direction = "forward"

    def __post_init__(self) -> None:
        """Rejects a request that cannot describe a grid."""
        if self.bpm <= 0.0:
            raise ValueError(f"bpm must be positive, got {self.bpm}")
        if self.bars < 1 or self.overlap_bars < 1:
            raise ValueError("bars and overlap_bars must be >= 1")
        if self.direction not in ("forward", "backward"):
            raise ValueError(f"direction must be forward or backward, got {self.direction!r}")

    @property
    def beats_per_bar(self) -> int:
        """Beats in a bar as counted by the requested meter (4/4 → 4)."""
        return self.time_signature[0]

    @property
    def beat_sec(self) -> float:
        """Length of one beat."""
        return 60.0 / self.bpm

    @property
    def bar_sec(self) -> float:
        """Length of one bar."""
        return self.beat_sec * self.beats_per_bar

    @property
    def overlap_sec(self) -> float:
        """Length of the splicing overlap (2 bars by default)."""
        return self.bar_sec * self.overlap_bars


@dataclass(frozen=True)
class FillGateRequest:
    """The grid of a two-sided request (09 §4.3-4.4, §6).

    A fill is gated at two seams, so it needs the lead as well as the gap: the
    generated span starts ``lead_bars`` before the join between the two contexts
    and ``gap_bars`` separate the contexts (0 for a transition). The seam steps
    themselves run on :attr:`grid`, a normal forward :class:`GateRequest` for the
    left side; the right side uses the same grid with the roles swapped.
    """

    bpm: float
    time_signature: tuple[int, int]
    key: KeySpec
    gap_bars: int
    lead_bars: float
    overlap_bars: int = 1

    def __post_init__(self) -> None:
        """Rejects a request that cannot describe a span with two contexts."""
        if self.bpm <= 0.0:
            raise ValueError(f"bpm must be positive, got {self.bpm}")
        if self.time_signature[0] < 1 or self.time_signature[1] < 1:
            raise ValueError(f"time signature must be positive, got {self.time_signature}")
        if self.gap_bars < 0 or self.lead_bars < 0.0:
            raise ValueError("gap_bars and lead_bars must be >= 0")
        if self.gap_bars + 2.0 * self.lead_bars <= 0.0:
            raise ValueError("gap_bars and lead_bars cannot both be zero")
        if self.overlap_bars < 1:
            raise ValueError(f"overlap_bars must be >= 1, got {self.overlap_bars}")

    @property
    def beats_per_bar(self) -> int:
        """Beats in a bar as counted by the requested meter."""
        return self.time_signature[0]

    @property
    def beat_sec(self) -> float:
        """Length of one beat."""
        return 60.0 / self.bpm

    @property
    def bar_sec(self) -> float:
        """Length of one bar."""
        return self.beat_sec * self.beats_per_bar

    @property
    def middle_bars(self) -> float:
        """Bars between the two overlaps."""
        return self.gap_bars + 2.0 * self.lead_bars

    @property
    def gap_sec(self) -> float:
        """Length of the missing audio between the contexts."""
        return self.bar_sec * self.gap_bars

    @property
    def lead_sec(self) -> float:
        """How far the generated middle starts before the join."""
        return self.bar_sec * self.lead_bars

    @property
    def overlap_sec(self) -> float:
        """Length of the splicing overlap on each side."""
        return self.bar_sec * self.overlap_bars

    @property
    def grid(self) -> GateRequest:
        """The same grid as an extend-style request, for the seven gate steps."""
        return GateRequest(
            bpm=self.bpm,
            time_signature=self.time_signature,
            key=self.key,
            bars=max(1, math.ceil(self.middle_bars)),
            overlap_bars=self.overlap_bars,
            direction="forward",
        )


@dataclass(frozen=True)
class StepVerdict:
    """One gate's outcome and its metrics."""

    step: str
    passed: bool
    metrics: Mapping[str, MetricValue] = field(default_factory=dict)
    reason: str | None = None
    skipped: bool = False


@dataclass(frozen=True)
class KeyMatch:
    """How the candidate's detected key relates to the requested one (09 §6 step 3)."""

    detected: KeySpec
    confidence: float
    relation: Literal["same", "relative", "shifted", "off"]
    shift_semitones: int


@dataclass(frozen=True)
class MatchEq:
    """The ``match_eq`` fx parameters of 03 §8.2 (31 bands, ±6 dB)."""

    bands: tuple[float, ...]
    amount: float = 1.0

    def params(self) -> dict[str, object]:
        """The ``FxParams``-shaped mapping the caller attaches to the clip."""
        return {"bands": list(self.bands), "amount": self.amount}


@dataclass(frozen=True)
class GateResult:
    """Everything the caller needs to audition, place and explain a candidate."""

    #: The processed audio: the generated part only, trimmed at the splice. For a
    #: rejected candidate it is whatever the gates processed up to the failure.
    processed: Audio
    passed: bool
    steps: tuple[StepVerdict, ...]
    #: 09 §6: a failed candidate is still returned, flagged for the UI.
    quality_warning: bool
    #: 03 §8.2 seam score of the final render (lower is better).
    seam_score: float
    #: Relative tempo error before warping, 0..1 (0 when it could not be measured).
    tempo_error: float
    key_match: KeyMatch | None
    match_eq: MatchEq | None
    #: Where ``processed`` starts relative to the context edge being extended: the
    #: context end for forward, the context start for backward. Negative means it
    #: starts inside the overlap, i.e. before the context end (forward).
    splice_offset_samples: int
    direction: Direction

    def verdict(self, step: str) -> StepVerdict:
        """The verdict for one step name."""
        for verdict in self.steps:
            if verdict.step == step:
                return verdict
        raise KeyError(step)


@dataclass(frozen=True)
class FillGateResult:
    """A two-sided candidate's gates: both seams, their offsets and their scores.

    ``processed`` is the generated span trimmed at both splices, with a fade-in of
    the gate's crossfade length at the head and a fade-out of the same length at
    the tail. ``start_offset_samples`` is where it starts relative to the gap
    start (the join between the contexts; negative is inside the before overlap)
    and ``end_offset_samples`` where it ends relative to the gap end (positive is
    inside the after overlap). Both are in the aligned timeline the gates score,
    the same frame ``GenerateExtendResult.spliceOffsetSamples`` uses.
    """

    processed: Audio
    passed: bool
    steps: tuple[StepVerdict, ...]
    quality_warning: bool
    #: 03 §8.2 seam score of the start splice, ``inf`` when it could not be scored.
    seam_score: float
    #: The same at the end splice, against ``after``.
    end_seam_score: float
    tempo_error: float
    key_match: KeyMatch | None
    match_eq: MatchEq | None
    start_offset_samples: int
    end_offset_samples: int

    def verdict(self, step: str) -> StepVerdict:
        """The verdict for one step name."""
        for verdict in self.steps:
            if verdict.step == step:
                return verdict
        raise KeyError(step)
