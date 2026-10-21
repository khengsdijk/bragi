"""The ``GenerationBackend`` contract of ``specs/09-generation.md`` §3.1.

A capability talks to models only through this adapter, so swapping a model is a
routing change (``config/generation_routes.yaml``) rather than a code change. The
backend owns model-specific conditioning and the generation itself; the capability
owns the job envelope, the quality gates and the placement metadata.

The request is expressed in bars and the song's musical facts, not in samples of
generated audio: every backend returns ``bars + overlap_bars`` bars, where the first
``overlap_bars`` re-create the context edge so the gate pass can choose its splice
point inside it (09 §4.2, §6).
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal, Protocol

from bragi_generate.postprocess.types import Audio, KeySpec

#: Latency tier of 09 §5.
type Tier = Literal["preview", "hq"]
#: Where the new audio goes (09 §4.2 step 5).
type Direction = Literal["forward", "backward"]


@dataclass(frozen=True)
class GenRequest:
    """Everything a backend needs to continue one song.

    Args:
        capability: The capability name, e.g. ``generate.extend``.
        context: The rendered context (48 kHz float32). For ``forward`` it is the
            song's tail, for ``backward`` its head.
        bpm: Conditioning tempo.
        time_signature: Numerator and denominator, e.g. ``(4, 4)``.
        key: Conditioning key.
        bars: Bars of new audio, not counting the overlap.
        overlap_bars: Bars of context the backend may re-create for the splice.
        direction: Forward (outro) or backward (intro).
        descriptors: Style descriptors; never artist names (10 §7).
        seed: The base seed. A backend may derive one seed per candidate from it.
        prompt: Optional user prompt, already rewritten by the planner/API.
        section_kind: Optional section kind the new part should feel like.
        energy: Optional target energy in 0..1.
        chords: Optional ``(startBeat, symbol)`` pairs, beats relative to the new span.
    """

    capability: str
    context: Audio
    bpm: float
    time_signature: tuple[int, int]
    key: KeySpec
    bars: int
    overlap_bars: int
    direction: Direction
    descriptors: tuple[str, ...]
    seed: int
    prompt: str | None = None
    section_kind: str | None = None
    energy: float | None = None
    chords: tuple[tuple[float, str], ...] = ()

    def __post_init__(self) -> None:
        """Rejects a request that cannot describe a musical span."""
        if self.bpm <= 0.0:
            raise ValueError(f"bpm must be positive, got {self.bpm}")
        if self.time_signature[0] < 1 or self.time_signature[1] < 1:
            raise ValueError(f"time signature must be positive, got {self.time_signature}")
        if self.bars < 1:
            raise ValueError(f"bars must be >= 1, got {self.bars}")
        if not 1 <= self.overlap_bars < self.bars + self.overlap_bars:
            raise ValueError(f"overlap_bars must be >= 1, got {self.overlap_bars}")
        if self.direction not in ("forward", "backward"):
            raise ValueError(f"direction must be forward or backward, got {self.direction!r}")
        if not 0 <= self.seed <= 0xFFFFFFFF:
            raise ValueError(f"seed must be a 32-bit unsigned integer, got {self.seed}")

    @property
    def beat_sec(self) -> float:
        """One beat, counted by the meter's numerator (09 §6's grid)."""
        return 60.0 / self.bpm

    @property
    def bar_sec(self) -> float:
        """One bar at the requested tempo and meter."""
        return self.beat_sec * self.time_signature[0]

    @property
    def new_duration_sec(self) -> float:
        """The new audio only, without the overlap."""
        return self.bar_sec * self.bars

    @property
    def overlap_sec(self) -> float:
        """The part of the context the backend re-creates for the splice."""
        return self.bar_sec * self.overlap_bars

    @property
    def total_duration_sec(self) -> float:
        """The full candidate: the overlap plus the new audio."""
        return self.new_duration_sec + self.overlap_sec


@dataclass(frozen=True)
class GenTimings:
    """Where a backend's wall clock went, in seconds."""

    generate_sec: float
    download_sec: float
    total_sec: float

    def __post_init__(self) -> None:
        """Timings are durations, never negative."""
        for name in ("generate_sec", "download_sec", "total_sec"):
            if getattr(self, name) < 0.0:
                raise ValueError(f"{name} must be >= 0, got {getattr(self, name)}")


@dataclass(frozen=True)
class GenOutput:
    """One finished candidate and the provenance of 09 §8.

    ``audio`` starts at the context edge (forward) or at the start of the intro
    (backward) and is ``overlap + new`` long; the gates trim it at the splice.
    """

    audio: Audio
    seed: int
    model: str
    model_version: str
    timings: GenTimings


class GenerationBackend(Protocol):
    """Structural type of a generation adapter (09 §3.1).

    ``capabilities`` is a :class:`frozenset` rather than the spec's ``set`` because
    callers only ever read it; a mutable class attribute would be shared state.
    """

    name: str
    version: str
    capabilities: frozenset[str]
    max_duration_sec: float
    supports_audio_context: bool
    supports_lyrics: bool
    supports_preview_tier: bool

    def generate(
        self,
        req: GenRequest,
        tier: Tier,
        n: int,
        on_progress: Callable[[float], None],
    ) -> list[GenOutput]:
        """Generates ``n`` candidates, calling ``on_progress(0..1)`` as they finish."""
        ...

    def warmup(self) -> None:
        """Loads the model so the next interactive generation is warm (09 §5).

        Blocking like :meth:`generate`; a backend whose model is already loaded or
        external (the fake backend) returns immediately.
        """
        ...


__all__ = [
    "Direction",
    "GenOutput",
    "GenRequest",
    "GenTimings",
    "GenerationBackend",
    "Tier",
]
