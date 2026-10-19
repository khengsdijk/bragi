"""Builds the feature digest ``describe`` sends to the model (``specs/04`` §5.6, §6.3).

Pure functions over the generated blob models: no I/O, no model call. The digest holds only
derived numbers and controlled-vocabulary labels. It never holds audio, lyrics, file names or
artist or title metadata (``specs/10`` §7, ``specs/05`` privacy note).

Inputs are the ``structure``, ``loudness_energy``, ``harmony``, ``rhythm``, ``tag`` and
``stem_activity`` blobs; any of them may be absent and then the matching fields are empty.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from bragi_common.generated.models import (
    HarmonyResult,
    LoudnessEnergyResult,
    RhythmResult,
    StemActivityResult,
    StructureResult,
    TagResult,
    TagScore,
)

#: A stem counts as "present" in a section when its gate is open for at least this share of it.
STEM_PRESENCE_MIN = 0.25

#: Energy-shape thresholds on the thirds' mean energy (0..1 scale, ``specs/04`` §5.5).
SHAPE_SLOPE_MIN = 0.15
SHAPE_PEAK_MIN = 0.10


@dataclass(frozen=True)
class SectionRecord:
    """One section in the §5.6 shape, joined from the stage blobs by section index."""

    index: int
    kind: str
    startSec: float  # noqa: N815
    endSec: float  # noqa: N815
    repeatGroup: str | None  # noqa: N815
    bars: int | None
    meanEnergy: float | None  # noqa: N815
    energySlope: float | None  # noqa: N815
    chords: str | None
    activeStems: tuple[str, ...]  # noqa: N815


@dataclass(frozen=True)
class DescribeFeatures:
    """Everything the describe prompt may say something about."""

    durationSec: float | None = None  # noqa: N815 - mirrors the §5.6 field names
    tempoBpm: float | None = None  # noqa: N815
    keyTonic: str | None = None  # noqa: N815
    keyMode: str | None = None  # noqa: N815
    energyShape: str | None = None  # noqa: N815
    energyMin: float | None = None  # noqa: N815
    energyMax: float | None = None  # noqa: N815
    sections: tuple[SectionRecord, ...] = ()
    genres: tuple[str, ...] = ()
    moods: tuple[str, ...] = ()
    instruments: tuple[str, ...] = ()
    descriptors: tuple[str, ...] = ()
    activeStems: tuple[str, ...] = ()  # noqa: N815
    lowConfidenceStages: tuple[str, ...] = ()  # noqa: N815
    #: Stage names whose blob was not passed (for the prompt's "unknown" note).
    missingStages: tuple[str, ...] = ()  # noqa: N815

    @property
    def section_indices(self) -> frozenset[int]:
        """The section indices a ``sectionNotes`` entry may refer to."""
        return frozenset(section.index for section in self.sections)


def build(
    *,
    structure: StructureResult | None = None,
    loudness: LoudnessEnergyResult | None = None,
    harmony: HarmonyResult | None = None,
    rhythm: RhythmResult | None = None,
    tags: TagResult | None = None,
    stems: StemActivityResult | None = None,
) -> DescribeFeatures:
    """Joins the blobs into one ``DescribeFeatures``. Missing blobs leave their fields empty."""
    tempo = float(rhythm.bpm) if rhythm is not None else None
    beats_per_bar = _beats_per_bar(rhythm)
    duration = _duration(structure, loudness)
    energy_min, energy_max, shape = _energy(loudness)
    stem_presence = _stem_presence(stems)
    sections = _sections(structure, loudness, harmony, stem_presence, tempo, beats_per_bar)

    key_tonic = harmony.key.tonic if harmony is not None else None
    key_mode = str(harmony.key.mode.value) if harmony is not None else None

    # ``loudness_energy`` has no ``lowConfidence`` field (04 §5.5), so only these four can flag.
    low_confidence = tuple(
        name
        for name, flag in (
            ("structure", structure is not None and bool(structure.lowConfidence)),
            ("harmony", harmony is not None and bool(harmony.lowConfidence)),
            ("rhythm", rhythm is not None and bool(rhythm.lowConfidence)),
            ("tag", tags is not None and bool(tags.lowConfidence)),
        )
        if flag
    )
    missing = tuple(
        name
        for name, blob in (
            ("structure", structure),
            ("loudness_energy", loudness),
            ("harmony", harmony),
            ("rhythm", rhythm),
            ("tag", tags),
            ("stem_activity", stems),
        )
        if blob is None
    )

    return DescribeFeatures(
        durationSec=duration,
        tempoBpm=tempo,
        keyTonic=key_tonic,
        keyMode=key_mode,
        energyShape=shape,
        energyMin=energy_min,
        energyMax=energy_max,
        sections=sections,
        genres=_labels(tags.genres) if tags is not None else (),
        moods=_labels(tags.moods) if tags is not None else (),
        instruments=_labels(tags.instruments) if tags is not None else (),
        descriptors=_labels(tags.descriptors) if tags is not None else (),
        activeStems=(
            tuple(sorted(str(stem.role.value) for stem in stems.stems if stem.active))
            if stems is not None
            else ()
        ),
        lowConfidenceStages=low_confidence,
        missingStages=missing,
    )


def _labels(scores: Sequence[TagScore]) -> tuple[str, ...]:
    """Tag labels in their stored order, without the scores (the model needs no numbers)."""
    return tuple(score.label for score in scores)


def _beats_per_bar(rhythm: RhythmResult | None) -> int | None:
    if rhythm is None:
        return None
    numerator = int(rhythm.timeSignature.numerator)
    return numerator if numerator > 0 else None


def _duration(
    structure: StructureResult | None, loudness: LoudnessEnergyResult | None
) -> float | None:
    if structure is not None and structure.sections:
        return float(structure.sections[-1].endSec)
    if loudness is not None and loudness.energy:
        return float(len(loudness.energy)) * float(loudness.hopSec)
    return None


def _energy(
    loudness: LoudnessEnergyResult | None,
) -> tuple[float | None, float | None, str | None]:
    """Min, max and a plain-language shape from the thirds' mean energy (04 §5.5)."""
    if loudness is None or not loudness.energy:
        return None, None, None
    values = [float(v) for v in loudness.energy]
    count = len(values)
    third = max(1, count // 3)
    first = _mean(values[:third])
    middle = _mean(values[third : count - third]) if count > 2 * third else _mean(values)
    last = _mean(values[count - third :])
    if last - first >= SHAPE_SLOPE_MIN:
        shape = "builds toward the end"
    elif first - last >= SHAPE_SLOPE_MIN:
        shape = "winds down toward the end"
    elif middle - max(first, last) >= SHAPE_PEAK_MIN:
        shape = "peaks in the middle"
    else:
        shape = "fairly steady"
    return round(min(values), 3), round(max(values), 3), shape


def _mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _stem_presence(
    stems: StemActivityResult | None,
) -> dict[int, dict[str, float]]:
    """Section index -> {stem role: share of the section the stem gate is open}."""
    table: dict[int, dict[str, float]] = {}
    if stems is None:
        return table
    for stem in stems.stems:
        role = str(stem.role.value)
        for entry in stem.presence:
            table.setdefault(int(entry.index), {})[role] = float(entry.presence)
    return table


def _sections(
    structure: StructureResult | None,
    loudness: LoudnessEnergyResult | None,
    harmony: HarmonyResult | None,
    stem_presence: dict[int, dict[str, float]],
    tempo: float | None,
    beats_per_bar: int | None,
) -> tuple[SectionRecord, ...]:
    if structure is None:
        return ()
    energy_by_index = (
        {int(e.index): e for e in loudness.sections}
        if loudness is not None and loudness.sections
        else {}
    )
    chords_by_index = (
        {int(p.index): _collapse(p.romanNumerals) for p in harmony.sections}
        if harmony is not None and harmony.sections
        else {}
    )
    records: list[SectionRecord] = []
    for index, section in enumerate(structure.sections):
        start = float(section.startSec)
        end = float(section.endSec)
        energy = energy_by_index.get(index)
        presence = stem_presence.get(index, {})
        records.append(
            SectionRecord(
                index=index,
                kind=str(section.kind.value),
                startSec=round(start, 2),
                endSec=round(end, 2),
                repeatGroup=section.repeatGroup,
                bars=_bars(end - start, tempo, beats_per_bar),
                meanEnergy=round(float(energy.meanEnergy), 3) if energy is not None else None,
                energySlope=round(float(energy.energySlope), 3) if energy is not None else None,
                chords=chords_by_index.get(index),
                activeStems=tuple(
                    sorted(role for role, share in presence.items() if share >= STEM_PRESENCE_MIN)
                ),
            )
        )
    return tuple(records)


def _bars(length_sec: float, tempo: float | None, beats_per_bar: int | None) -> int | None:
    if tempo is None or beats_per_bar is None or tempo <= 0:
        return None
    return max(1, round(length_sec * tempo / 60.0 / beats_per_bar))


def _collapse(numerals: list[str]) -> str | None:
    """``["i", "i", "VI"]`` -> ``"i-VI"`` (the §5.6 chord summary, immediate repeats removed)."""
    out: list[str] = []
    for numeral in numerals:
        if not out or out[-1] != numeral:
            out.append(numeral)
    return "-".join(out) if out else None


__all__ = ["STEM_PRESENCE_MIN", "DescribeFeatures", "SectionRecord", "build"]
