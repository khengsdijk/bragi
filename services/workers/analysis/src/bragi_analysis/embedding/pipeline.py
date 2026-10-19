"""Turning audio into ``EmbeddingResult`` blobs (``specs/04`` §6.1).

One primitive covers every scope: window the *whole* signal once (10 s/5 s), weight each
window's vector by its coverage of the requested spans, pool and L2-normalise. A song has no
spans (every window counts), a section is one span, a stem's spans are its active regions.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

from bragi_analysis.embedding import windows
from bragi_analysis.embedding.protocol import Embedder
from bragi_common.generated.models import (
    EmbeddingResult,
    EmbeddingResultSchemaVersion,
    EmbeddingScope,
    EmbeddingVector,
)

type F64 = NDArray[np.float64]
type Spans = Sequence[tuple[float, float]]


@dataclass(frozen=True)
class Span:
    """A named span to embed: the ``scopeRef`` and its seconds."""

    ref: str
    start_sec: float
    end_sec: float


def pooled_vector(
    embedder: Embedder, mono: NDArray[np.floating], sample_rate: int, spans: Spans | None
) -> tuple[F64, bool]:
    """The L2-normalised, overlap-weighted pool over ``spans`` (all windows when ``None``)."""
    duration = mono.shape[0] / sample_rate
    grid = windows.window_spans(duration)
    vectors = embedder.window_vectors(mono, sample_rate)
    if len(vectors) != len(grid):
        raise ValueError(
            f"the embedder returned {len(vectors)} window vectors for {len(grid)} windows"
        )
    if spans is None:
        return windows.pool(vectors, None, embedder.dim)
    weights = [windows.coverage(window, spans) for window in grid]
    return windows.pool(vectors, weights, embedder.dim)


def _result(
    scope: EmbeddingScope, model: str, dim: int, vectors: list[tuple[str | None, F64]], low: bool
) -> EmbeddingResult:
    return EmbeddingResult(
        schemaVersion=EmbeddingResultSchemaVersion.integer_1,
        scope=scope,
        model=model,
        dim=dim,
        vectors=[
            EmbeddingVector(
                scopeRef=ref,
                vector=np.asarray(vector, dtype=np.float64).tolist(),
            )
            for ref, vector in vectors
        ],
        lowConfidence=True if low else None,
    )


def song_result(
    embedder: Embedder, mono: NDArray[np.floating], sample_rate: int
) -> EmbeddingResult:
    """One song-level vector (``scope: "song"``)."""
    vector, low = pooled_vector(embedder, mono, sample_rate, None)
    return _result(EmbeddingScope.song, embedder.model, embedder.dim, [(None, vector)], low)


def section_result(
    embedder: Embedder,
    mono: NDArray[np.floating],
    sample_rate: int,
    sections: Sequence[Span],
) -> EmbeddingResult:
    """One vector per section span (``scope: "section"``)."""
    vectors: list[tuple[str | None, F64]] = []
    low = not sections
    for section in sections:
        vector, degraded = pooled_vector(
            embedder, mono, sample_rate, [(section.start_sec, section.end_sec)]
        )
        vectors.append((section.ref, vector))
        low = low or degraded
    return _result(EmbeddingScope.section, embedder.model, embedder.dim, vectors, low)


def stem_result(
    embedder: Embedder,
    stems: Mapping[str, tuple[NDArray[np.floating], int, Spans | None]],
) -> EmbeddingResult:
    """One vector per stem, pooled over its active regions (``scope: "stem"``).

    ``stems`` maps a stem role to ``(mono, sample_rate, active_spans)``; ``active_spans`` is
    ``None`` (or empty) when the stem has no ``stem_activity`` blob, meaning the whole stem.
    """
    vectors: list[tuple[str | None, F64]] = []
    low = not stems
    for role, (mono, sample_rate, spans) in stems.items():
        vector, degraded = pooled_vector(embedder, mono, sample_rate, spans or None)
        vectors.append((role, vector))
        low = low or degraded
    return _result(EmbeddingScope.stem, embedder.model, embedder.dim, vectors, low)


__all__ = ["Span", "pooled_vector", "section_result", "song_result", "stem_result"]
