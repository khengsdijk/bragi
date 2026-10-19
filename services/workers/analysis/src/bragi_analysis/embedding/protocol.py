"""The ``Embedder`` seam (``specs/04`` §6.1, WP-1.6).

An embedder maps audio and text into one L2-normalised 512-d space. Two implementations exist:
:class:`bragi_analysis.embedding.clap.CLAPEmbedder` (the v1 target, weight-pinned) and
:class:`bragi_analysis.embedding.fallback.FallbackEmbedder` (deterministic, NumPy-only, the
weight-free CI/runtime path). Swapping the model never touches windowing, pooling, storage or
the blob contract. See [ADR-0011](../../../../../specs/decisions/ADR-0011-embeddings-and-tags.md).
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Protocol, runtime_checkable

import numpy as np
from numpy.typing import NDArray

from bragi_analysis.embedding import windows

type F64 = NDArray[np.float64]

#: The v1 model ids recorded in ``EmbeddingResult.model``.
CLAP_MODEL = "laion-clap-music-1"
FALLBACK_MODEL = "bragi-concept-basis-1"

#: What ``select`` accepts.
EmbedderKind = str  # "auto" | "clap" | "fallback"


@runtime_checkable
class Embedder(Protocol):
    """A joint audio-text embedder."""

    @property
    def model(self) -> str:
        """The model id recorded in the blob (e.g. ``laion-clap-music-1``)."""
        ...

    @property
    def dim(self) -> int:
        """The vector length (512 for the v1 checkpoints)."""
        ...

    def window_vectors(self, mono: NDArray[np.floating], sample_rate: int) -> list[F64]:
        """One L2-normalised vector per 10 s/5 s window of ``mono`` (04 §6.1)."""
        ...

    def embed_texts(self, texts: Sequence[str]) -> F64:
        """One L2-normalised vector per text, shape ``(len(texts), dim)``."""
        ...


class EmbedderUnavailableError(RuntimeError):
    """Raised when a requested embedder cannot run (e.g. missing CLAP weights)."""


def select(kind: EmbedderKind = "auto") -> Embedder:
    """Picks an embedder: ``clap`` (required), ``fallback``, or ``auto`` (CLAP if available)."""
    from bragi_analysis.embedding.fallback import FallbackEmbedder

    if kind == "fallback":
        return FallbackEmbedder()
    if kind == "clap":
        from bragi_analysis.embedding.clap import CLAPEmbedder

        return CLAPEmbedder.load()
    if kind == "auto":
        from bragi_analysis.embedding.clap import CLAPEmbedder

        if CLAPEmbedder.available():
            return CLAPEmbedder.load()
        return FallbackEmbedder()
    raise ValueError(f"unknown embedder {kind!r}; expected 'auto', 'clap' or 'fallback'")


__all__ = [
    "CLAP_MODEL",
    "FALLBACK_MODEL",
    "Embedder",
    "EmbedderKind",
    "EmbedderUnavailableError",
    "select",
    "windows",
]
