"""The ``analysis.harmony`` capability end to end, with a fake context."""

from __future__ import annotations

import asyncio
import hashlib
from pathlib import Path
from typing import cast

import numpy as np
import pytest
from analysis_support import needs_ffmpeg, wav_bytes
from harmony_support import SAMPLE_RATE, render

from bragi_analysis import rhythm_post
from bragi_analysis.capabilities import harmony
from bragi_common.cancel import JobCancelledError
from bragi_common.context import JobContext
from bragi_common.generated.models import (
    FreeformParams,
    HarmonyResult,
    JobInputs,
    JobOutputs,
    JobPriority,
    JobRequest,
    JobRequestSchemaVersion,
    SectionKind,
    StructureResult,
    StructureResultSchemaVersion,
    StructureSection,
)

C_MAJOR = [(0, "maj"), (5, "maj"), (7, "maj"), (0, "maj")]

HASH_A = "sha256:" + "a" * 64
HASH_B = "sha256:" + "b" * 64
HASH_C = "sha256:" + "c" * 64
HASH_D = "sha256:" + "d" * 64


class FakeContext:
    """The slice of ``JobContext`` the harmony capability uses, with per-hash audio."""

    def __init__(
        self, scratch: Path, sources: dict[str, bytes], *, cancel_after: int | None = None
    ) -> None:
        self.scratch = scratch
        self.sources = sources
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
        return self.sources[content_hash]

    async def upload(self, data: bytes, mime: str | None = None) -> str:
        key = "sha256:" + hashlib.sha256(data).hexdigest()
        self.uploads[key] = data
        return key

    async def upload_json(self, document: str) -> str:
        return await self.upload(document.encode(), "application/json")


def make_job(
    assets: dict[str, str],
    blobs: dict[str, str] | None = None,
    params: dict[str, object] | None = None,
) -> JobRequest:
    return JobRequest(
        schemaVersion=JobRequestSchemaVersion.integer_1,
        jobId="job_01HARM",
        capability=harmony.CAPABILITY,
        priority=JobPriority.interactive,
        userId="user_01",
        inputs=JobInputs(
            assets=assets,
            blobs=blobs,
            params=FreeformParams.model_validate(params or {}),
        ),
        idempotencyKey="key",
        attempt=0,
        deadline="2026-10-19T00:00:00.000Z",
        traceparent="00-11111111111111111111111111111111-2222222222222222-01",
        createdAt="2026-10-19T00:00:00.000Z",
    )


def run(job: JobRequest, context: FakeContext) -> JobOutputs:
    return asyncio.run(harmony.run(job, cast(JobContext, context)))


def harmony_result(outputs: JobOutputs, context: FakeContext) -> HarmonyResult:
    assert outputs.blobs is not None and "harmony" in outputs.blobs
    return HarmonyResult.model_validate_json(context.uploads[outputs.blobs["harmony"]])


def test_capability_contract() -> None:
    assert harmony.CAPABILITY == "analysis.harmony"
    assert harmony.ParamsModel().recognizer == "auto"
    assert harmony.ParamsModel().useBeats is True
    with pytest.raises(ValueError, match="extra"):
        harmony.ParamsModel.model_validate({"nope": 1})


def test_a_missing_input_is_rejected() -> None:
    context = FakeContext(Path(), {})
    with pytest.raises(ValueError, match=r"assets\.stem"):
        run(make_job({}), context)


@needs_ffmpeg
def test_capability_publishes_a_harmony_blob_from_harmonic_stems(tmp_path: Path) -> None:
    audio = render(C_MAJOR, reps=2)
    data = wav_bytes(audio, SAMPLE_RATE)
    context = FakeContext(tmp_path, {HASH_A: data, HASH_B: data})
    job = make_job({"stem_bass": HASH_A, "stem_other": HASH_B})

    outputs = run(job, context)
    result = harmony_result(outputs, context)

    assert result.key.tonic == "C"
    assert result.key.mode.value == "major"
    assert result.key.confidence > 0.4
    assert [chord.symbol for chord in result.chords[:4]] == ["C", "F", "G", "C"]
    assert result.sections is not None and result.sections[0].index == 0
    assert result.lowConfidence is False
    assert context.reports == sorted(context.reports)
    assert context.reports[-1] == 1.0


@needs_ffmpeg
def test_capability_falls_back_to_the_source_when_there_are_no_stems(tmp_path: Path) -> None:
    data = wav_bytes(render(C_MAJOR, reps=2), SAMPLE_RATE)
    context = FakeContext(tmp_path, {HASH_A: data})
    result = harmony_result(run(make_job({"source": HASH_A}), context), context)
    assert result.key.tonic == "C"
    assert result.chords


@needs_ffmpeg
def test_capability_honours_rhythm_and_structure_blobs(tmp_path: Path) -> None:
    audio = render(C_MAJOR, reps=4)
    duration = audio.shape[0] / SAMPLE_RATE
    beats = np.arange(0.5, duration, 0.5)
    rhythm = rhythm_post.build_result(beats, beats[::4], duration)
    structure = StructureResult(
        schemaVersion=StructureResultSchemaVersion.integer_1,
        sections=[
            StructureSection(
                startSec=0.0, endSec=duration / 2.0, kind=SectionKind.verse, confidence=0.9
            ),
            StructureSection(
                startSec=duration / 2.0,
                endSec=duration,
                kind=SectionKind.chorus,
                confidence=0.9,
            ),
        ],
    )
    data = wav_bytes(audio, SAMPLE_RATE)
    context = FakeContext(tmp_path, {HASH_A: data})
    # The capability downloads blobs by their hash, so store the two JSON blobs
    # under the hashes the job references.
    context.sources[HASH_C] = rhythm.model_dump_json(exclude_none=True).encode()
    context.sources[HASH_D] = structure.model_dump_json(exclude_none=True).encode()
    job = make_job({"source": HASH_A}, blobs={"rhythm": HASH_C, "structure": HASH_D})

    result = harmony_result(run(job, context), context)
    assert result.sections is not None
    assert [section.index for section in result.sections] == [0, 1]
    edges = np.unique(np.concatenate([[0.0], beats, [duration]]))
    for chord in result.chords:
        assert np.min(np.abs(edges - chord.endSec)) < 1e-3


@needs_ffmpeg
def test_capability_degrades_gracefully_on_silence_and_short(tmp_path: Path) -> None:
    silent = wav_bytes(np.zeros(SAMPLE_RATE * 3, dtype=np.float32), SAMPLE_RATE)
    short = wav_bytes(render([(0, "maj")], reps=1, seconds=0.3), SAMPLE_RATE)
    for data in (silent, short):
        context = FakeContext(tmp_path, {HASH_A: data})
        result = harmony_result(run(make_job({"source": HASH_A}), context), context)
        assert result.lowConfidence is True


@needs_ffmpeg
def test_capability_cancels_before_analysing(tmp_path: Path) -> None:
    data = wav_bytes(render(C_MAJOR, reps=2), SAMPLE_RATE)
    context = FakeContext(tmp_path, {HASH_A: data}, cancel_after=0)
    with pytest.raises(JobCancelledError):
        run(make_job({"source": HASH_A}), context)
    assert not context.uploads


def test_capability_is_registered_with_the_worker() -> None:
    from bragi_analysis import worker

    assert harmony in worker.CAPABILITIES
