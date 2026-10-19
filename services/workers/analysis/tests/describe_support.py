"""Shared fixtures for the WP-1.7 describe tests: a fake client and synthetic analysis blobs.

Everything here is generated in-process: no audio, no network, no ``ANTHROPIC_API_KEY``. The blob
builders mirror the stage outputs of ``specs/04`` §5 so the feature join, the prompt, the grounding
post-check and the checklist can be exercised without any real analysis run.
"""

from __future__ import annotations

import hashlib
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from bragi_analysis.describe.features import DescribeFeatures
from bragi_common.generated.models import (
    Chord,
    FreeformParams,
    HarmonyResult,
    HarmonyResultSchemaVersion,
    JobInputs,
    JobPriority,
    JobRequest,
    JobRequestSchemaVersion,
    KeyEstimate,
    KeyMode,
    LoudnessEnergyResult,
    LoudnessEnergyResultSchemaVersion,
    RhythmResult,
    RhythmResultSchemaVersion,
    RhythmTimeSignature,
    SecRange,
    SectionEnergy,
    SectionKind,
    SectionPresence,
    SectionProgression,
    StemActivity,
    StemActivityResult,
    StemActivityResultSchemaVersion,
    StemRole,
    StructureResult,
    StructureResultSchemaVersion,
    StructureSection,
    TagResult,
    TagResultSchemaVersion,
    TagScore,
    TempoCurvePoint,
    TimeSigDenominator,
)

TRACEPARENT = "00-11111111111111111111111111111111-2222222222222222-01"

HASH_STRUCTURE = "sha256:" + "a" * 64
HASH_LOUDNESS = "sha256:" + "b" * 64
HASH_HARMONY = "sha256:" + "c" * 64
HASH_RHYTHM = "sha256:" + "d" * 64
HASH_TAG = "sha256:" + "e" * 64
HASH_STEMS = "sha256:" + "f" * 64


class FakeDescribeClient:
    """A ``DescribeClient`` returning canned replies, recording every call."""

    def __init__(self, replies: Sequence[str]) -> None:
        self._replies = list(replies)
        self.calls: list[dict[str, Any]] = []

    async def complete(self, *, model: str, system: str, user: str, max_tokens: int) -> str:
        """Records the call and returns the next canned reply."""
        self.calls.append(
            {"model": model, "system": system, "user": user, "max_tokens": max_tokens}
        )
        if not self._replies:
            raise AssertionError("FakeDescribeClient ran out of canned replies")
        return self._replies.pop(0)


class FakeContext:
    """The slice of ``JobContext`` the describe capability uses, keyed by content hash."""

    def __init__(
        self,
        scratch: Path,
        blobs: dict[str, bytes],
        *,
        cancel_after: int | None = None,
    ) -> None:
        self.scratch = scratch
        self.blobs = blobs
        self.uploads: dict[str, bytes] = {}
        self.reports: list[float] = []
        self._cancel_after = cancel_after
        self._polls = 0

    def scratch_path(self, name: str) -> Path:
        return self.scratch / name

    async def progress(self, pct: float, eta: float | None = None) -> None:
        self.reports.append(pct)

    async def cancelled(self) -> bool:
        self._polls += 1
        return self._cancel_after is not None and self._polls > self._cancel_after

    async def download(self, content_hash: str) -> bytes:
        return self.blobs[content_hash]

    async def upload(self, data: bytes, mime: str | None = None) -> str:
        key = "sha256:" + hashlib.sha256(data).hexdigest()
        self.uploads[key] = data
        return key

    async def upload_json(self, document: str) -> str:
        return await self.upload(document.encode(), "application/json")


def make_job(
    capability: str,
    blobs: dict[str, str] | None = None,
    params: dict[str, object] | None = None,
) -> JobRequest:
    """A ``JobRequest`` for ``capability`` with blobs and params (no assets)."""
    return JobRequest(
        schemaVersion=JobRequestSchemaVersion.integer_1,
        jobId="job_01DESCRIBE",
        capability=capability,
        priority=JobPriority.interactive,
        userId="user_01",
        inputs=JobInputs(
            assets={},
            params=FreeformParams.model_validate(params or {}),
            blobs=blobs,
        ),
        idempotencyKey="key",
        attempt=0,
        deadline="2026-10-19T00:00:00.000Z",
        traceparent=TRACEPARENT,
        createdAt="2026-10-19T00:00:00.000Z",
    )


def structure_result(*, low_confidence: bool | None = None) -> StructureResult:
    """Intro / verse / chorus, 0..24..40 s, groups A/B/C, downbeat-aligned."""
    return StructureResult(
        schemaVersion=StructureResultSchemaVersion.integer_1,
        sections=[
            StructureSection(
                startSec=0.0, endSec=8.0, kind=SectionKind.intro, confidence=0.9, repeatGroup="A"
            ),
            StructureSection(
                startSec=8.0, endSec=24.0, kind=SectionKind.verse, confidence=0.88, repeatGroup="B"
            ),
            StructureSection(
                startSec=24.0,
                endSec=40.0,
                kind=SectionKind.chorus,
                confidence=0.92,
                repeatGroup="C",
            ),
        ],
        lowConfidence=low_confidence,
    )


def loudness_result() -> LoudnessEnergyResult:
    """A rising energy curve on a 0.5 s hop and matching per-section aggregates."""
    energy = [round(0.2 + 0.8 * index / 79, 3) for index in range(80)]
    return LoudnessEnergyResult(
        schemaVersion=LoudnessEnergyResultSchemaVersion.integer_1,
        hopSec=0.5,
        lufsIntegrated=-9.0,
        lra=5.0,
        truePeakDb=-1.0,
        shortTermLufs=[-18.0 + index * 0.05 for index in range(80)],
        energy=energy,
        sections=[
            SectionEnergy(index=0, meanEnergy=0.25, peakEnergy=0.35, energySlope=0.02),
            SectionEnergy(index=1, meanEnergy=0.45, peakEnergy=0.6, energySlope=0.05),
            SectionEnergy(index=2, meanEnergy=0.85, peakEnergy=0.95, energySlope=0.08),
        ],
    )


def harmony_result(*, tonic: str = "C", mode: KeyMode = KeyMode.major) -> HarmonyResult:
    """C major with an I-V-vi-IV progression per section."""
    return HarmonyResult(
        schemaVersion=HarmonyResultSchemaVersion.integer_1,
        key=KeyEstimate(tonic=tonic, mode=mode, confidence=0.8),
        chords=[
            Chord(startSec=0.0, endSec=4.0, symbol="C", root="C", quality="maj", confidence=0.8),
            Chord(startSec=4.0, endSec=8.0, symbol="G", root="G", quality="maj", confidence=0.8),
        ],
        sections=[
            SectionProgression(
                index=0, romanNumerals=["I", "I", "V"], progressionFingerprint="I-V"
            ),
            SectionProgression(index=1, romanNumerals=["vi", "IV"], progressionFingerprint="vi-IV"),
            SectionProgression(
                index=2, romanNumerals=["I", "V", "vi", "IV"], progressionFingerprint="I-V-vi-IV"
            ),
        ],
    )


def rhythm_result(*, bpm: float = 100.0) -> RhythmResult:
    """100 BPM in 4/4 with a coarse but valid beat grid."""
    beats = [round(index * 60.0 / bpm, 3) for index in range(67)]
    return RhythmResult(
        schemaVersion=RhythmResultSchemaVersion.integer_1,
        bpm=bpm,
        beats=beats,
        downbeats=beats[::4],
        tempoCurve=[TempoCurvePoint(beat=index, bpm=bpm) for index in range(4)],
        timeSignature=RhythmTimeSignature(numerator=4, denominator=TimeSigDenominator.integer_4),
        confidence=0.9,
        isTempoStable=True,
    )


def tag_result(*, low_confidence: bool | None = None) -> TagResult:
    """A plausible pop fixture: pop/uplifting, piano+drums+bass+vocals."""
    return TagResult(
        schemaVersion=TagResultSchemaVersion.integer_1,
        genres=[TagScore(label="pop", score=0.8)],
        moods=[TagScore(label="uplifting", score=0.7)],
        instruments=[
            TagScore(label="piano", score=0.8),
            TagScore(label="drums", score=0.8),
            TagScore(label="bass", score=0.7),
            TagScore(label="vocals", score=0.7),
        ],
        descriptors=[TagScore(label="warm", score=0.6)],
        lowConfidence=low_confidence,
    )


def _presence(index: int, share: float) -> SectionPresence:
    return SectionPresence(index=index, presence=share)


def stem_result() -> StemActivityResult:
    """Drums/bass/vocals/piano all active across the song, with per-section presence."""

    def stem(role: StemRole, shares: tuple[float, float, float]) -> StemActivity:
        return StemActivity(
            role=role,
            active=[SecRange(startSec=0.0, endSec=40.0)],
            presence=[_presence(index, share) for index, share in enumerate(shares)],
        )

    return StemActivityResult(
        schemaVersion=StemActivityResultSchemaVersion.integer_1,
        stems=[
            stem(StemRole.drums, (0.7, 0.8, 0.95)),
            stem(StemRole.bass, (0.4, 0.7, 0.9)),
            stem(StemRole.vocals, (0.1, 0.9, 0.95)),
            stem(StemRole.piano, (0.6, 0.6, 0.7)),
        ],
    )


#: The blob set of the "pop" fixture, keyed by the name the capability expects.
def pop_blobs() -> dict[str, Any]:
    """A complete analysis blob set for one synthetic pop song."""
    return {
        "structure": structure_result(),
        "loudness_energy": loudness_result(),
        "harmony": harmony_result(),
        "rhythm": rhythm_result(),
        "tag": tag_result(),
        "stem_activity": stem_result(),
    }


def blob_hash_map(blobs: dict[str, Any]) -> dict[str, str]:
    """Upload-shaped mapping of blob name -> content hash for the fixed test hashes."""
    hashes = {
        "structure": HASH_STRUCTURE,
        "loudness_energy": HASH_LOUDNESS,
        "harmony": HASH_HARMONY,
        "rhythm": HASH_RHYTHM,
        "tag": HASH_TAG,
        "stem_activity": HASH_STEMS,
    }
    return {name: hashes[name] for name in blobs}


def blob_bytes(blobs: dict[str, Any]) -> dict[str, bytes]:
    """Content-hash -> JSON bytes, matching :func:`blob_hash_map`."""
    hashes = blob_hash_map(blobs)
    return {hashes[name]: model.model_dump_json().encode() for name, model in blobs.items()}


GOOD_REPLY = (
    '{"summary": "A warm piano-led pop song that grows from a quiet intro into a wide chorus. '
    'The drums and bass hold a steady groove under the vocal.", '
    '"sectionNotes": [{"index": 2, "text": "The chorus opens up with the full band."}], '
    '"whatMakesItWorks": ["The arrangement builds energy toward the chorus."]}'
)


def describe_features() -> DescribeFeatures:
    """The ``DescribeFeatures`` of the pop fixture."""
    from bragi_analysis.describe import features as feature_builder

    blobs = pop_blobs()
    return feature_builder.build(
        structure=blobs["structure"],
        loudness=blobs["loudness_energy"],
        harmony=blobs["harmony"],
        rhythm=blobs["rhythm"],
        tags=blobs["tag"],
        stems=blobs["stem_activity"],
    )


__all__ = [
    "GOOD_REPLY",
    "HASH_HARMONY",
    "HASH_LOUDNESS",
    "HASH_RHYTHM",
    "HASH_STEMS",
    "HASH_STRUCTURE",
    "HASH_TAG",
    "FakeContext",
    "FakeDescribeClient",
    "blob_bytes",
    "blob_hash_map",
    "describe_features",
    "harmony_result",
    "loudness_result",
    "make_job",
    "pop_blobs",
    "rhythm_result",
    "stem_result",
    "structure_result",
    "tag_result",
]
