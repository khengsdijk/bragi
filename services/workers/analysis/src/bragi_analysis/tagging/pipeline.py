"""Building a ``TagResult`` from a song embedding (``specs/04`` §6.2).

Per category: a trained MLP head when one is present, otherwise zero-shot cosine over the
taxonomy prompts. The top-k labels (``config/tag.toml``) that clear ``minScore`` are published.
Every result from the weight-free fallback is flagged ``lowConfidence``, so a caller can tell
untrained labels from trained ones.
"""

from __future__ import annotations

import tomllib
from dataclasses import dataclass
from functools import lru_cache
from importlib import resources

import numpy as np
from numpy.typing import NDArray

from bragi_analysis.embedding.protocol import Embedder
from bragi_analysis.tagging import zeroshot
from bragi_analysis.tagging.taxonomy import CATEGORIES, Category, Taxonomy
from bragi_common.generated.models import TagResult, TagResultSchemaVersion, TagScore

type F64 = NDArray[np.float64]


@dataclass(frozen=True)
class Limits:
    """``config/tag.toml``: how many labels of each category, and the score floor."""

    top_k: dict[Category, int]
    min_score: float

    def for_category(self, category: Category) -> int:
        """The top-k limit of one category."""
        return self.top_k[category]


@lru_cache(maxsize=1)
def limits() -> Limits:
    """The packaged tagging limits, read once."""
    text = resources.files("bragi_analysis").joinpath("config/tag.toml").read_text("utf-8")
    raw = tomllib.loads(text)
    top_k = {
        category: int(raw["topK"][category]) for category in CATEGORIES if category in raw["topK"]
    }
    for category in CATEGORIES:
        top_k.setdefault(category, 1)
    return Limits(top_k=top_k, min_score=float(raw["thresholds"]["minScore"]))


def _scored(labels: tuple[str, ...], scores: F64, top_k: int, min_score: float) -> list[TagScore]:
    """The top-``top_k`` labels with a score over ``min_score``, best first."""
    order = sorted(range(len(labels)), key=lambda index: (-float(scores[index]), labels[index]))
    out: list[TagScore] = []
    for index in order:
        score = float(scores[index])
        if len(out) >= top_k or score <= min_score:
            break
        out.append(TagScore(label=labels[index], score=min(1.0, max(0.0, score))))
    return out


def build_result(
    audio_vector: F64,
    taxonomy: Taxonomy,
    embedder: Embedder,
    heads: dict[Category, zeroshot.Head],
    limits_: Limits | None = None,
    *,
    degraded: bool = False,
) -> TagResult:
    """Scores every category and returns a ``TagResult``.

    Args:
        audio_vector: The L2-normalised song embedding.
        taxonomy: The controlled vocabulary.
        embedder: The same embedder that produced ``audio_vector`` (text shares its space).
        heads: Trained heads, keyed by category (empty for the zero-shot fallback).
        limits_: Top-k limits; the packaged ``config/tag.toml`` when omitted.
        degraded: Force ``lowConfidence`` (e.g. the input audio was silent).
    """
    limits_ = limits_ or limits()
    scored: dict[Category, list[TagScore]] = {}
    for category in CATEGORIES:
        entries = taxonomy.entries(category)
        labels = tuple(entry.label for entry in entries)
        head = heads.get(category)
        if head is not None:
            head_scores = zeroshot.classify(head, audio_vector)
            by_label = {label: float(head_scores[i]) for i, label in enumerate(head.labels)}
            scores = np.asarray([by_label.get(label, 0.0) for label in labels], dtype=np.float64)
        else:
            prompts = [entry.prompt for entry in entries]
            scores = zeroshot.cosine_scores(audio_vector, embedder.embed_texts(prompts))
        scored[category] = _scored(
            labels, scores, limits_.for_category(category), limits_.min_score
        )

    untrained = not heads
    return TagResult(
        schemaVersion=TagResultSchemaVersion.integer_1,
        genres=scored["genres"],
        moods=scored["moods"],
        instruments=scored["instruments"],
        descriptors=scored["descriptors"],
        era=scored["eras"][0] if scored["eras"] else None,
        lowConfidence=True if (degraded or untrained) else None,
    )


__all__ = ["Limits", "build_result", "limits"]
