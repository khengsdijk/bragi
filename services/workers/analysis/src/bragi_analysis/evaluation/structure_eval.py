"""Structure scoring for the eval harness (``specs/04`` §8, WP-1.4).

Three gates, each ``PASS`` / ``FAIL`` only when *every* eligible track was scored:

* boundary hit-rate (recall at +-3 s, ``mir_eval.segment.detection``) mean >= 0.70;
* label accuracy (duration-weighted ``SectionKind`` agreement) mean >= 0.60;
* repeat groups: of the songs with >= 2 labelled choruses, >= 80 % have all choruses in one
  ``repeatGroup`` that no other section shares.

Synthetic songs (generated, exact ground truth) prove this machinery in a separate report
section and never decide a gate.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import numpy as np

from bragi_analysis.evaluation import metrics, synthetic_songs
from bragi_analysis.structure import pipeline
from bragi_analysis.trackers.base import BeatTracker
from bragi_common.generated.models import StructureResult

GateStatus = Literal["PASS", "FAIL", "PENDING"]


@dataclass(frozen=True)
class StructureScore:
    """The outcome for one track."""

    id: str
    status: Literal["scored", "missing", "hash_mismatch", "error"]
    boundary_hit_rate: float | None = None
    boundary_precision: float | None = None
    label_accuracy: float | None = None
    #: ``None`` when the song has fewer than two reference choruses.
    chorus_grouping: bool | None = None
    sections_found: int = 0
    sections_expected: int = 0
    detail: str = ""


@dataclass(frozen=True)
class StructureGate:
    """One gate's verdict with the reason."""

    name: str
    threshold: float
    status: GateStatus
    value: float | None
    reason: str


def parse_sections(text: str) -> list[metrics.LabelledSection]:
    """Sections from a ``.sections`` file: ``<start> <end> <kind> [group]`` per line.

    ``kind`` is a ``SectionKind`` value; ``#`` starts a comment. Ordered, contiguous.
    """
    sections: list[metrics.LabelledSection] = []
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        fields = line.split()
        if len(fields) < 3:
            raise ValueError(f"expected '<start> <end> <kind> [group]', got {raw!r}")
        sections.append(
            metrics.LabelledSection(
                float(fields[0]),
                float(fields[1]),
                fields[2],
                fields[3] if len(fields) > 3 else None,
            )
        )
    return sections


def from_result(result: StructureResult) -> list[metrics.LabelledSection]:
    """A published ``StructureResult`` as metric sections."""
    return [
        metrics.LabelledSection(s.startSec, s.endSec, s.kind.value, s.repeatGroup)
        for s in result.sections
    ]


def score(
    track_id: str, reference: list[metrics.LabelledSection], estimate: list[metrics.LabelledSection]
) -> StructureScore:
    """Scores one estimate against its reference."""
    hit, precision, _ = metrics.boundary_scores(reference, estimate)
    return StructureScore(
        id=track_id,
        status="scored",
        boundary_hit_rate=hit,
        boundary_precision=precision,
        label_accuracy=metrics.label_accuracy(reference, estimate),
        chorus_grouping=metrics.chorus_grouping_correct(reference, estimate),
        sections_found=len(estimate),
        sections_expected=len(reference),
    )


def gates_for(scores: list[StructureScore], total: int) -> list[StructureGate]:
    """The three structure gates over ``total`` eligible tracks (those with section labels)."""
    boundary_name = "boundary hit-rate (+-3 s)"
    label_name = "label accuracy"
    group_name = "chorus repeat groups"
    pending_reason: str | None = None
    if total == 0:
        pending_reason = "no eval track has a section label file: the eval set does not exist yet"
    scored = [s for s in scores if s.status == "scored"]
    if pending_reason is None and len(scored) < total:
        pending_reason = (
            f"only {len(scored)} of {total} eval tracks could be scored "
            "(audio not fetched, hash mismatch or error)"
        )
    if pending_reason is not None:
        return [
            StructureGate(
                boundary_name, metrics.BOUNDARY_HIT_GATE, "PENDING", None, pending_reason
            ),
            StructureGate(label_name, metrics.LABEL_ACCURACY_GATE, "PENDING", None, pending_reason),
            StructureGate(
                group_name, metrics.CHORUS_GROUPING_GATE, "PENDING", None, pending_reason
            ),
        ]

    def mean_gate(name: str, threshold: float, values: list[float]) -> StructureGate:
        mean = float(np.mean(values))
        ok = mean >= threshold
        return StructureGate(
            name,
            threshold,
            "PASS" if ok else "FAIL",
            mean,
            f"mean {mean:.3f} {'>=' if ok else '<'} {threshold}",
        )

    boundary = mean_gate(
        boundary_name,
        metrics.BOUNDARY_HIT_GATE,
        [s.boundary_hit_rate for s in scored if s.boundary_hit_rate is not None],
    )
    label = mean_gate(
        label_name,
        metrics.LABEL_ACCURACY_GATE,
        [s.label_accuracy for s in scored if s.label_accuracy is not None],
    )
    eligible = [s for s in scored if s.chorus_grouping is not None]
    if not eligible:
        grouping = StructureGate(
            group_name,
            metrics.CHORUS_GROUPING_GATE,
            "PENDING",
            None,
            "no eval song has >= 2 labelled choruses",
        )
    else:
        share = sum(1 for s in eligible if s.chorus_grouping) / len(eligible)
        ok = share >= metrics.CHORUS_GROUPING_GATE
        grouping = StructureGate(
            group_name,
            metrics.CHORUS_GROUPING_GATE,
            "PASS" if ok else "FAIL",
            share,
            f"{share:.0%} of {len(eligible)} songs with >= 2 choruses "
            f"{'>=' if ok else '<'} {metrics.CHORUS_GROUPING_GATE:.0%}",
        )
    return [boundary, label, grouping]


def score_synthetic(tracker: BeatTracker | None = None) -> list[StructureScore]:
    """Scores the synthetic songs.

    With a ``tracker`` the beats come from it (the whole chain); without, from the generator's
    exact beat grid (the segmenter alone).
    """
    scores = []
    for song in synthetic_songs.suite():
        if tracker is None:
            analysis = pipeline.analyse(song.audio, song.sample_rate, song.beats, song.downbeats)
        else:
            analysis = pipeline.analyse_with_tracker(song.audio, song.sample_rate, tracker)
        reference = [metrics.LabelledSection(s.startSec, s.endSec, s.kind) for s in song.sections]
        scores.append(score(song.name, reference, from_result(analysis.result)))
    return scores
