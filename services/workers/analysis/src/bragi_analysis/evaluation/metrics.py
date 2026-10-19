"""Beat metrics for the eval gate (``specs/04`` §8)."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass

import mir_eval
import numpy as np
from numpy.typing import NDArray

#: 04 §8: beat F-measure with a +-70 ms window.
BEAT_TOLERANCE_SEC = 0.07
#: 04 §8: the v1 gate for `rhythm`.
BEAT_F_GATE = 0.85


def beat_f_measure(
    reference: NDArray[np.float64],
    estimate: NDArray[np.float64],
    tolerance_sec: float = BEAT_TOLERANCE_SEC,
) -> float:
    """``mir_eval`` beat F-measure at +-``tolerance_sec`` (no leading-seconds trim).

    Two empty sequences score 1.0 (nothing to find, nothing found); one empty
    side scores 0.0.
    """
    if reference.size == 0 and estimate.size == 0:
        return 1.0
    if reference.size == 0 or estimate.size == 0:
        return 0.0
    return float(
        mir_eval.beat.f_measure(
            np.sort(reference), np.sort(estimate), f_measure_threshold=tolerance_sec
        )
    )


# --- structure (04 section 8, WP-1.4) -------------------------------------------------------

#: 04 §8: boundary hit-rate at +-3 s.
BOUNDARY_TOLERANCE_SEC = 3.0
#: 04 §8: the v1 gates for `structure`.
BOUNDARY_HIT_GATE = 0.70
LABEL_ACCURACY_GATE = 0.60
#: 12 (WP-1.4): share of songs with >= 2 choruses whose choruses share a repeat group.
CHORUS_GROUPING_GATE = 0.80


@dataclass(frozen=True)
class LabelledSection:
    """A section as the structure metrics see it (reference or estimate)."""

    start_sec: float
    end_sec: float
    kind: str
    repeat_group: str | None = None


def _intervals(sections: list[LabelledSection]) -> NDArray[np.float64]:
    return np.asarray([[s.start_sec, s.end_sec] for s in sections], dtype=np.float64)


def boundary_scores(
    reference: list[LabelledSection],
    estimate: list[LabelledSection],
    tolerance_sec: float = BOUNDARY_TOLERANCE_SEC,
) -> tuple[float, float, float]:
    """Boundary ``(hit-rate, precision, F)`` at +-``tolerance_sec`` via ``mir_eval.segment``.

    The hit-rate is the *recall* of reference boundaries (04 §8: "boundary hit-rate"). The
    start and end of the song are not counted as boundaries (``trim=True``: they are trivially
    hit, which would flatter every score).
    """
    if not reference or not estimate:
        return 0.0, 0.0, 0.0
    if len(reference) == 1:
        # No interior reference boundary: nothing to hit; precision is what the estimate costs.
        return 1.0, 1.0 if len(estimate) == 1 else 0.0, 1.0 if len(estimate) == 1 else 0.0
    precision, recall, f_measure = mir_eval.segment.detection(
        _intervals(reference), _intervals(estimate), window=tolerance_sec, trim=True
    )
    return float(recall), float(precision), float(f_measure)


def label_accuracy(reference: list[LabelledSection], estimate: list[LabelledSection]) -> float:
    """Share of the reference duration whose estimated ``SectionKind`` equals the reference's."""
    total = sum(r.end_sec - r.start_sec for r in reference)
    if total <= 0:
        return 0.0
    agree = 0.0
    for ref in reference:
        for est in estimate:
            overlap = min(ref.end_sec, est.end_sec) - max(ref.start_sec, est.start_sec)
            if overlap > 0 and ref.kind == est.kind:
                agree += overlap
    return agree / total


def _best_overlap(section: LabelledSection, others: list[LabelledSection]) -> int:
    overlaps = [
        min(section.end_sec, o.end_sec) - max(section.start_sec, o.start_sec) for o in others
    ]
    return int(np.argmax(overlaps))


def chorus_grouping_correct(
    reference: list[LabelledSection], estimate: list[LabelledSection]
) -> bool | None:
    """Do the reference choruses fall into one estimated repeat group, and only they?

    Each reference chorus is matched to the estimated section overlapping it most. The song is
    correct when all those estimated sections share one ``repeatGroup`` and no estimated
    section matched to a *non*-chorus reference section shares it. ``None`` when the reference
    has fewer than two choruses (the song is not part of the gate).
    """
    choruses = [r for r in reference if r.kind == "chorus"]
    if len(choruses) < 2 or not estimate:
        return None
    groups = {estimate[_best_overlap(c, estimate)].repeat_group for c in choruses}
    if len(groups) != 1 or None in groups:
        return False
    group = next(iter(groups))
    others = [r for r in reference if r.kind != "chorus"]
    return all(estimate[_best_overlap(o, estimate)].repeat_group != group for o in others)


# --- embeddings & tagging (04 §8, WP-1.6) ------------------------------------

#: 04 §8: share of eval songs whose top-3 genres agree with the hand label.
TAG_GENRE_GATE = 0.70
#: 12 (WP-1.6): share of eval songs where `"drums"` ranks the drum stem first.
EMBED_DRUM_RANK_GATE = 0.90


def ranks(query: NDArray[np.floating], candidates: Mapping[str, NDArray[np.floating]]) -> list[str]:
    """Candidate keys sorted by descending cosine with ``query`` (ties keep input order).

    This is the `"drums"`-ranking metric of 04 §8 (WP-1.6): a text query's cosine against each
    stem's embedding. Both sides are L2-normalised, so a plain dot product is the cosine.
    """
    q = np.asarray(query, dtype=np.float64)
    q_norm = float(np.linalg.norm(q))
    if q_norm < 1e-9:
        return list(candidates)
    scored = [
        (key, float(np.asarray(value, dtype=np.float64) @ q) / q_norm)
        for key, value in candidates.items()
    ]
    return [key for key, _ in sorted(scored, key=lambda item: -item[1])]


def drum_rank_accuracy(
    cases: Sequence[tuple[NDArray[np.floating], Mapping[str, NDArray[np.floating]], str]],
) -> float:
    """Share of cases whose drum key ranks first for the `"drums"` query (04 §8, WP-1.6).

    Each case is ``(drums text embedding, {stem key: embedding}, drum stem key)``. This is the
    acceptance metric; the eval harness supplies one case per eval song, the tests a synthetic one.
    """
    if not cases:
        return 0.0
    hits = sum(ranks(query, candidates)[:1] == [drum_key] for query, candidates, drum_key in cases)
    return hits / len(cases)
