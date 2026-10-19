"""Zero-shot scoring and small MLP heads (``specs/04`` §6.2).

Descripters (and, until trained heads exist, every category) are scored by the cosine of the
song's audio embedding against a label's text template. When trained MLP heads are present in
``BRAGI_TAG_HEADS`` they replace the zero-shot score for genre/mood/instrument.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
from numpy.typing import NDArray

from bragi_analysis.tagging.taxonomy import Category

type F64 = NDArray[np.float64]


def cosine_scores(audio: F64, text_vectors: F64) -> F64:
    """Cosine of ``audio`` against each row of ``text_vectors``, clipped to 0..1.

    A zero text vector (a label whose prompt matched no concept) scores 0.
    """
    audio_norm = float(np.linalg.norm(audio))
    norms = np.linalg.norm(text_vectors, axis=1)
    if audio_norm < 1e-9:
        return np.zeros(text_vectors.shape[0], dtype=np.float64)
    denom = np.where(norms > 1e-9, norms * audio_norm, 1.0)
    scores = (text_vectors @ audio) / denom
    return np.clip(np.where(norms > 1e-9, scores, 0.0), 0.0, 1.0)


@dataclass(frozen=True)
class Head:
    """One trained MLP head: two layers over the song embedding."""

    category: Category
    labels: tuple[str, ...]
    weight_in: F64
    bias_in: F64
    weight_out: F64
    bias_out: F64


def classify(head: Head, vector: F64) -> F64:
    """The head's softmax over its labels for one song embedding."""
    hidden = np.maximum(head.weight_in @ vector + head.bias_in, 0.0)
    logits = head.weight_out @ hidden + head.bias_out
    shifted = logits - float(np.max(logits))
    exp = np.exp(shifted)
    return np.asarray(exp / float(exp.sum()), dtype=np.float64)


def load_heads(directory: Path | None) -> dict[Category, Head]:
    """Loads ``<category>.npz`` heads from ``directory`` (empty when it is unset or absent)."""
    if directory is None or not directory.is_dir():
        return {}
    heads: dict[Category, Head] = {}
    for category in ("genres", "moods", "instruments"):
        path = directory / f"{category}.npz"
        if not path.is_file():
            continue
        with np.load(path) as data:
            heads[category] = Head(
                category=category,
                labels=tuple(str(label) for label in data["labels"]),
                weight_in=data["w1"].astype(np.float64),
                bias_in=data["b1"].astype(np.float64),
                weight_out=data["w2"].astype(np.float64),
                bias_out=data["b2"].astype(np.float64),
            )
    return heads


__all__ = ["Head", "classify", "cosine_scores", "load_heads"]
