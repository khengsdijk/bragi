"""From chroma to a ``HarmonyResult`` (``specs/04`` §5.3, §10).

Pure orchestration: synchronise chroma to the beats if there are any, estimate the
key, decode the chords, refine the key from them, derive the roman numerals and the
per-section fingerprints, and package everything into the generated schema model.
Nothing here touches I/O, so it is tested on synthetic chroma directly.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

from bragi_analysis.harmony import key as keys
from bragi_analysis.harmony.chords import ChordRecognizer, ChordSegment, TemplateRecognizer
from bragi_analysis.harmony.chroma import NOTE_NAMES, ChromaFrames, beat_sync
from bragi_common.generated.models import (
    Chord,
    HarmonyResult,
    HarmonyResultSchemaVersion,
    KeyChange,
    KeyEstimate,
    KeyMode,
    SectionProgression,
)

#: Below this key confidence the result is flagged ``lowConfidence`` (04 §10).
LOW_CONFIDENCE = 0.4
#: Clips shorter than this cannot be analysed meaningfully.
MIN_ANALYSIS_SEC = 0.5


@dataclass(frozen=True)
class SectionSpan:
    """A section from the ``structure`` stage, or the whole song when there is none."""

    index: int
    start_sec: float
    end_sec: float


def build_result(
    frames: ChromaFrames,
    duration_sec: float,
    *,
    beats: NDArray[np.floating] | None = None,
    sections: Sequence[SectionSpan] | None = None,
    recognizer: ChordRecognizer | None = None,
    low_confidence_threshold: float = LOW_CONFIDENCE,
) -> HarmonyResult:
    """The ``HarmonyResult`` for chroma ``frames`` of a ``duration_sec``-long song.

    ``beats`` (from the ``rhythm`` stage) switch to beat-synchronous chroma; without
    them the frame grid is decoded directly. ``sections`` (from ``structure``) align
    the progressions; without them one whole-song progression at index 0 is emitted.
    """
    recognizer = recognizer or TemplateRecognizer()
    synced = beat_sync(frames, beats, duration_sec) if beats is not None and beats.size else frames
    base_key = keys.estimate_key(synced.vectors, synced.energy)
    segments = recognizer.recognize(synced)
    refined = base_key
    if segments:
        decided = keys.estimate_key(
            synced.vectors, synced.energy, extra=keys.chord_chroma(segments)
        )
        # The chord sequence picks the reading; the raw chroma still caps how
        # confident we are, so a bogus chord cannot manufacture confidence.
        refined = keys.Key(
            decided.tonic_pc, decided.mode, min(base_key.confidence, decided.confidence)
        )
    spans = list(sections) if sections else [SectionSpan(0, 0.0, duration_sec)]
    low_confidence = (
        refined.confidence < low_confidence_threshold
        or not segments
        or duration_sec < MIN_ANALYSIS_SEC
    )
    return HarmonyResult(
        schemaVersion=HarmonyResultSchemaVersion.integer_1,
        key=KeyEstimate(
            tonic=NOTE_NAMES[refined.tonic_pc % 12],
            mode=KeyMode(refined.mode),
            confidence=round(refined.confidence, 3),
        ),
        keyChanges=[
            KeyChange(
                atSec=round(change.at_sec, 4),
                tonic=NOTE_NAMES[change.tonic_pc % 12],
                mode=KeyMode(change.mode),
                confidence=round(change.confidence, 3),
            )
            for change in keys.detect_key_changes(synced, refined)
        ],
        chords=[_chord(segment, duration_sec) for segment in segments],
        sections=_progressions(spans, segments, refined) if segments else None,
        lowConfidence=low_confidence,
    )


def _chord(segment: ChordSegment, duration_sec: float) -> Chord:
    """One schema ``Chord`` from a decoded segment."""
    return Chord(
        startSec=round(min(segment.start_sec, duration_sec), 4),
        endSec=round(min(segment.end_sec, duration_sec), 4),
        symbol=segment.symbol,
        root=NOTE_NAMES[segment.root_pc % 12],
        quality=segment.quality,
        confidence=round(segment.confidence, 3),
    )


def _progressions(
    spans: Sequence[SectionSpan], segments: Sequence[ChordSegment], key: keys.Key
) -> list[SectionProgression]:
    """One ``SectionProgression`` per span, with its numerals and fingerprint."""
    progressions: list[SectionProgression] = []
    for span in spans:
        inside = [
            segment
            for segment in segments
            if segment.start_sec < span.end_sec and segment.end_sec > span.start_sec
        ]
        numerals = [keys.roman_numeral(s.root_pc, s.quality, key) for s in inside]
        progressions.append(
            SectionProgression(
                index=span.index,
                romanNumerals=numerals,
                progressionFingerprint=keys.fingerprint(numerals),
            )
        )
    return progressions


__all__ = ["LOW_CONFIDENCE", "MIN_ANALYSIS_SEC", "SectionSpan", "build_result"]
