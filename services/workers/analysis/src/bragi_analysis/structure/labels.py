"""Functional labels for sections, and the model-vocabulary -> ``SectionKind`` mapping.

The weight-free labeller guesses a function from three facts only: how often the material
recurs, how loud it is relative to the rest of the song, and where it sits. It speaks the
All-In-One vocabulary (``intro verse chorus bridge inst break outro``), and the mapping in
``config/structure_labels.json`` turns that into the schema's ``SectionKind``. A neural
segmenter that speaks the same vocabulary can replace :func:`label_sections` and reuse the
mapping, the start/end merge, the snapping and the grouping.

These are heuristics, not recognition: a loud twice-repeated block is *called* a chorus. The
label-accuracy gate (04 §8) measures how often that is right on real songs.
"""

from __future__ import annotations

import json
from collections import defaultdict
from dataclasses import dataclass
from functools import lru_cache
from importlib import resources

import numpy as np

from bragi_common.generated.models import SectionKind

#: A repeated group needs to be this much louder than the other repeated group to be the chorus.
ENERGY_TIE = 0.05
#: A unique mid-song section this far below the song's mean energy is a breakdown.
BREAKDOWN_BELOW = 0.35


@dataclass(frozen=True)
class SectionStats:
    """What the labeller knows about one section."""

    group: int
    #: Mean loudness of the section, rescaled to 0..1 across the song.
    energy: float


@dataclass(frozen=True)
class LabelMap:
    """``config/structure_labels.json``."""

    mapping: dict[str, SectionKind]
    merge_into_neighbour: frozenset[str]


@lru_cache(maxsize=1)
def label_map() -> LabelMap:
    """Loads the packaged mapping once."""
    text = (
        resources.files("bragi_analysis")
        .joinpath("config/structure_labels.json")
        .read_text("utf-8")
    )
    raw = json.loads(text)
    return LabelMap(
        {k: SectionKind(v) for k, v in raw["map"].items()}, frozenset(raw["mergeIntoNeighbour"])
    )


def to_section_kind(label: str) -> SectionKind:
    """Maps one model label to a ``SectionKind``; anything unknown becomes ``custom``."""
    return label_map().mapping.get(label, SectionKind.custom)


def merge_marker_sections(
    sections: list[tuple[float, float, str]],
) -> list[tuple[float, float, str]]:
    """Folds ``start`` / ``end`` marker sections into a neighbour (04 §5.2).

    A leading marker extends the next section backwards; any other marker extends the previous
    section forwards. If nothing but markers is left, one ``unknown`` section covers the span.
    """
    merge = label_map().merge_into_neighbour
    out: list[tuple[float, float, str]] = []
    pending_start: float | None = None
    for start, end, label in sections:
        if label in merge:
            if out:
                out[-1] = (out[-1][0], end, out[-1][2])
            elif pending_start is None:
                pending_start = start
            continue
        if pending_start is not None:
            start, pending_start = pending_start, None
        out.append((start, end, label))
    if not out and sections:
        return [(sections[0][0], sections[-1][1], "unknown")]
    return out


def label_sections(stats: list[SectionStats]) -> list[str]:
    """One model-vocabulary label per section, in order."""
    n = len(stats)
    if n == 0:
        return []
    if n == 1:
        return ["unknown"]
    members: dict[int, list[int]] = defaultdict(list)
    for i, s in enumerate(stats):
        members[s.group].append(i)
    # Material shared only by the first and the last section is a bookend (an intro that comes
    # back as the outro), not a verse or a chorus.
    repeated = {
        g: idx for g, idx in members.items() if len(idx) >= 2 and not set(idx) <= {0, n - 1}
    }
    group_energy = {
        g: float(np.mean([stats[i].energy for i in idx])) for g, idx in repeated.items()
    }

    labels = ["inst"] * n
    chorus_group: int | None = None
    if repeated:
        # Highest energy wins; near ties go to the group that recurs more often.
        best = max(group_energy.values())
        contenders = [g for g, e in group_energy.items() if e >= best - ENERGY_TIE]
        chorus_group = max(contenders, key=lambda g: (len(repeated[g]), group_energy[g]))
        if len(repeated) == 1 and group_energy[chorus_group] < float(
            np.median([s.energy for s in stats])
        ):
            chorus_group = None  # the only repeated material is quieter than the song: verse
        for g, idx in repeated.items():
            for i in idx:
                labels[i] = "chorus" if g == chorus_group else "verse"

    mean_energy = float(np.mean([s.energy for s in stats]))
    first_chorus = next((i for i, lab in enumerate(labels) if lab == "chorus"), None)
    for i, s in enumerate(stats):
        if s.group in repeated:
            continue
        if i == 0:
            labels[i] = "intro"
        elif i == n - 1:
            labels[i] = "outro"
        elif s.energy < mean_energy - BREAKDOWN_BELOW * max(mean_energy, 1e-9):
            labels[i] = "break"
        elif first_chorus is not None and i > first_chorus:
            labels[i] = "bridge"
        else:
            labels[i] = "inst"
    return labels
