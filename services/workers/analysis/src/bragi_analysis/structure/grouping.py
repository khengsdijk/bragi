"""Repeat groups: which sections are the same material again (``specs/04`` §5.2).

Two sections are compared beat by beat from their starts (a repeated verse starts on the same
bar phrase), after trimming the beats the smoothing filter blurred across the boundary. Their
similarity is the mean cosine of the aligned feature rows, and zero when their lengths differ
too much to be repetitions. Groups are the cut of an average-linkage dendrogram.
"""

from __future__ import annotations

import numpy as np
from numpy.typing import NDArray
from scipy.cluster import hierarchy

type F64 = NDArray[np.float64]

#: Two sections are repetitions when their aligned similarity reaches this. (Untuned on real
#: music: it is one of the constants to calibrate on the eval set, Q45.)
SAME_MATERIAL = 0.65
#: Sections whose lengths differ by more than this ratio are never grouped.
MIN_LENGTH_RATIO = 0.75
#: Beats trimmed from each end of a section before comparing (the smoothing bleed).
TRIM_BEATS = 2


def section_similarity(a: F64, b: F64) -> float:
    """Mean aligned cosine of two ``(beats, dims)`` feature runs, 0 if the lengths clash."""
    na, nb = a.shape[0], b.shape[0]
    if min(na, nb) < 1 or min(na, nb) / max(na, nb) < MIN_LENGTH_RATIO:
        return 0.0
    trim = min(TRIM_BEATS, (min(na, nb) - 1) // 2)
    n = min(na, nb)
    x = a[trim : n - trim]
    y = b[trim : n - trim]
    dot = np.sum(x * y, axis=1)
    norm = np.linalg.norm(x, axis=1) * np.linalg.norm(y, axis=1)
    return float(np.mean(dot / np.maximum(norm, 1e-9)))


def similarity_matrix(runs: list[F64]) -> F64:
    """Pairwise :func:`section_similarity` of ``runs`` (diagonal 1)."""
    n = len(runs)
    sim = np.eye(n)
    for i in range(n):
        for j in range(i + 1, n):
            sim[i, j] = sim[j, i] = section_similarity(runs[i], runs[j])
    return sim


def group_sections(similarity: F64, threshold: float = SAME_MATERIAL) -> list[int]:
    """Group index per section, numbered by first appearance (0, 1, 2, ...)."""
    n = similarity.shape[0]
    if n <= 1:
        return [0] * n
    distance = np.clip(1.0 - similarity, 0.0, 2.0)
    np.fill_diagonal(distance, 0.0)
    condensed = distance[np.triu_indices(n, k=1)]
    tree = hierarchy.linkage(condensed, method="average")
    labels = hierarchy.fcluster(tree, t=1.0 - threshold, criterion="distance")
    renumbered: dict[int, int] = {}
    return [renumbered.setdefault(int(label), len(renumbered)) for label in labels]


def group_letter(index: int) -> str:
    """``0 -> A``, ``25 -> Z``, ``26 -> AA`` ..."""
    letters = ""
    index += 1
    while index > 0:
        index, rem = divmod(index - 1, 26)
        letters = chr(ord("A") + rem) + letters
    return letters
