"""The structure analysis: audio + beat grid -> ``StructureResult`` (``specs/04`` §5.2).

Weight-free v1 (ADR-0010, ``stageVersion`` :data:`STAGE_VERSION`):

1. beat-synchronous chroma + timbre + energy (:mod:`.features`);
2. self-similarity and Foote novelty -> boundary candidates (:mod:`.novelty`);
3. snap to downbeats and the 2-/4-bar phrase grid (:mod:`.snap`);
4. repeat groups by aligned section similarity (:mod:`.grouping`);
5. heuristic functional labels, mapped to ``SectionKind`` (:mod:`.labels`).

Every failure mode of the *music* (too short, no pulse, no structure) degrades to one section
flagged ``lowConfidence``; none of them is a job failure (04 §10).
"""

from __future__ import annotations

import itertools
from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

from bragi_analysis import rhythm_post
from bragi_analysis.structure import features, grouping, labels, novelty, snap
from bragi_analysis.trackers.base import BeatTracker
from bragi_common.generated.models import (
    SectionKind,
    StructureResult,
    StructureResultSchemaVersion,
)

type F64 = NDArray[np.float64]

STAGE_VERSION = "structure@ssm-novelty-1"

#: Fewer beats than this cannot hold two sections of MIN_SECTION_BEATS: one section.
MIN_BEATS = 2 * novelty.MIN_SECTION_BEATS
#: Pseudo-beat period used when no usable beat grid is given.
FALLBACK_BEAT_SEC = 0.5
#: Beat confidence (04 §10) below which the result is flagged low-confidence.
LOW_BEAT_CONFIDENCE = 0.4


@dataclass(frozen=True)
class Analysis:
    """The result plus what the evaluation and the tests want to look at."""

    result: StructureResult
    novelty: F64
    used_fallback_grid: bool


def _single(duration: float, kind: SectionKind, confidence: float) -> StructureResult:
    return StructureResult.model_validate(
        {
            "schemaVersion": StructureResultSchemaVersion.integer_1,
            "sections": [
                {
                    "startSec": 0.0,
                    "endSec": duration,
                    "kind": kind,
                    "confidence": confidence,
                    "repeatGroup": "A",
                }
            ],
            "lowConfidence": True,
        }
    )


def _usable(beats: F64, duration: float) -> bool:
    return beats.size >= MIN_BEATS and float(np.median(np.diff(beats))) > 0.05 and duration > 0


def analyse_with_tracker(
    mono: NDArray[np.floating], sample_rate: int, tracker: BeatTracker
) -> Analysis:
    """Tracks the beats with ``tracker`` (as the ``rhythm`` stage would), then segments."""
    estimate = tracker.track(mono.astype(np.float32), sample_rate)
    rhythm = rhythm_post.build_result(
        estimate.beats, estimate.downbeats, mono.shape[0] / sample_rate
    )
    return analyse(
        mono,
        sample_rate,
        np.asarray(rhythm.beats, dtype=np.float64),
        np.asarray(rhythm.downbeats, dtype=np.float64),
        beat_confidence=rhythm.confidence,
    )


def analyse(
    mono: NDArray[np.floating],
    sample_rate: int,
    beats: F64,
    downbeats: F64,
    *,
    beat_confidence: float | None = None,
) -> Analysis:
    """Segments one mono signal.

    Args:
        mono: Mono audio.
        sample_rate: Its sample rate.
        beats: Beat times in seconds (ascending). Too few beats falls back to a 0.5 s grid.
        downbeats: Downbeat times in seconds, possibly empty.
        beat_confidence: The ``rhythm`` stage's confidence, when known; a low value flags the
            result low-confidence because the boundaries are then snapped to a doubtful grid.
    """
    duration = mono.shape[0] / sample_rate
    beats = np.asarray(beats, dtype=np.float64)
    downbeats = np.asarray(downbeats, dtype=np.float64)
    fallback_grid = not _usable(beats, duration)
    if fallback_grid:
        beats = np.arange(0.0, duration, FALLBACK_BEAT_SEC)
        downbeats = np.zeros(0)
    if duration <= 0 or beats.size < MIN_BEATS or float(np.max(np.abs(mono), initial=0.0)) < 1e-6:
        return Analysis(_single(max(duration, 0.0), SectionKind.custom, 0.0), np.zeros(0), True)

    feats = features.beat_features(mono, sample_rate, beats)
    ssm = novelty.self_similarity(feats.matrix)
    curve = novelty.novelty_curve(ssm)
    picked = novelty.pick_boundaries(curve)

    beat_sec = float(np.median(np.diff(beats)))
    min_gap = novelty.MIN_SECTION_BEATS * beat_sec
    strongest_first = sorted(zip(picked.strength, picked.beat_index, strict=True), reverse=True)
    raw_times = [float(beats[i]) for _, i in strongest_first]
    bounds = [
        b
        for b in snap.snap_boundaries(raw_times, beats, downbeats, min_gap)
        if b > min_gap * 0.5 and duration - b > min_gap * 0.5
    ]
    edges = [0.0, *bounds, duration]

    # Beat rows of each section and the novelty at its start.
    peak = float(curve.max()) if curve.size else 0.0
    runs: list[F64] = []
    energy_db: list[float] = []
    start_strength: list[float] = []
    for start, end in itertools.pairwise(edges):
        lo = int(np.searchsorted(beats, start - 1e-6, side="left")) if start > 0 else 0
        hi = int(np.searchsorted(beats, end - 1e-6, side="left"))
        hi = max(hi, min(lo + 1, beats.size))
        lo = min(lo, beats.size - 1)
        runs.append(feats.matrix[lo:hi])
        energy_db.append(float(np.mean(feats.energy_db[lo:hi])))
        at = min(int(np.argmin(np.abs(beats - start))), curve.size - 1)
        start_strength.append(1.0 if start == 0 or peak <= 0 else float(curve[at]) / peak)

    sim = grouping.similarity_matrix(runs)
    group_of = grouping.group_sections(sim)

    lo_db, hi_db = float(np.min(feats.energy_db)), float(np.max(feats.energy_db))
    span = max(hi_db - lo_db, 1e-9)
    stats = [
        labels.SectionStats(g, (e - lo_db) / span) for g, e in zip(group_of, energy_db, strict=True)
    ]
    model_labels = labels.label_sections(stats)

    sizes = np.bincount(group_of)
    sections = []
    for i, (start, end) in enumerate(itertools.pairwise(edges)):
        members = [j for j, g in enumerate(group_of) if g == group_of[i]]
        if len(members) > 1:
            cohesion = float(np.mean([sim[i, j] for j in members if j != i]))
            grouping_certainty = min(1.0, 0.6 + 0.1 * (sizes[group_of[i]] - 1)) * max(cohesion, 0.0)
        else:
            grouping_certainty = 0.5
        # Where the section begins matters, except for the first one (it begins at 0 for sure).
        boundary = start_strength[i] if i > 0 else (start_strength[1] if len(edges) > 2 else 0.0)
        confidence = float(np.clip(0.5 * boundary + 0.5 * grouping_certainty, 0.0, 1.0))
        sections.append(
            {
                "startSec": float(start),
                "endSec": float(end),
                "kind": labels.to_section_kind(model_labels[i]),
                "confidence": confidence,
                "repeatGroup": grouping.group_letter(group_of[i]),
            }
        )

    low = (
        fallback_grid
        or len(sections) == 1
        or (beat_confidence is not None and beat_confidence < LOW_BEAT_CONFIDENCE)
    )
    result = StructureResult.model_validate(
        {
            "schemaVersion": StructureResultSchemaVersion.integer_1,
            "sections": sections,
            **({"lowConfidence": True} if low else {}),
        }
    )
    return Analysis(result, curve, fallback_grid)
