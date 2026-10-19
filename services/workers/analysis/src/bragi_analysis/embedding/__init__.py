"""CLAP-family audio-text embeddings for song, section and stem scope (``specs/04`` §6.1).

The public seam is :mod:`bragi_analysis.embedding.protocol` (``Embedder``, ``select``);
windowing and pooling live in :mod:`bragi_analysis.embedding.windows` and
:mod:`bragi_analysis.embedding.pipeline`, persistence in
:mod:`bragi_analysis.embedding.store`. See
[ADR-0011](../../../../../specs/decisions/ADR-0011-embeddings-and-tags.md).
"""

from __future__ import annotations

__all__: list[str] = []
