"""The ``tag`` capability end to end, with a fake context (04 §6.2)."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import cast

import numpy as np
import pytest
from embedding_support import (
    HASH_EMBED,
    HASH_SOURCE,
    FakeContext,
    make_job,
    needs_ffmpeg,
    sine,
    synthetic_stems,
    wav_bytes,
)

from bragi_analysis.capabilities import tag
from bragi_common.cancel import JobCancelledError
from bragi_common.context import JobContext
from bragi_common.generated.models import EmbeddingResult, JobOutputs, TagResult

SAMPLE_RATE = 22_050


def _ctx(context: FakeContext) -> JobContext:
    return cast(JobContext, context)


def _tag_result(outputs: JobOutputs, context: FakeContext) -> TagResult:
    blobs = outputs.blobs
    assert blobs is not None and "tag" in blobs
    return TagResult.model_validate_json(context.uploads[blobs["tag"]])


def test_contract_and_registration() -> None:
    assert tag.CAPABILITY == "analysis.tag"
    assert tag.ParamsModel().classifier == "auto"
    from bragi_analysis import worker

    assert tag in worker.CAPABILITIES


@needs_ffmpeg
def test_tag_labels_the_source_with_the_fallback(tmp_path: Path) -> None:
    audio = wav_bytes(synthetic_stems(SAMPLE_RATE, 8.0)["drums"], SAMPLE_RATE)
    context = FakeContext(tmp_path, {HASH_SOURCE: audio})
    job = make_job(tag.CAPABILITY, {"source": HASH_SOURCE})
    outputs = asyncio.run(tag.run(job, _ctx(context)))
    result = _tag_result(outputs, context)

    assert result.lowConfidence is True  # the zero-shot fallback, no trained heads
    assert any(entry.label == "drums" for entry in result.instruments)
    assert 1 <= len(result.genres) <= 3
    assert len(result.moods) <= 4
    assert len(result.descriptors) <= 6
    assert context.reports[-1] == 1.0


@needs_ffmpeg
def test_tag_reuses_a_song_embedding_blob_without_decoding(tmp_path: Path) -> None:
    vector = np.zeros(512)
    vector[0] = 1.0
    embedding = EmbeddingResult.model_validate(
        {
            "schemaVersion": 1,
            "scope": "song",
            "model": "mock",
            "dim": 512,
            "vectors": [{"vector": vector.tolist()}],
        }
    )
    context = FakeContext(tmp_path, {HASH_EMBED: embedding.model_dump_json().encode()})
    job = make_job(tag.CAPABILITY, {}, blobs={"embed_full": HASH_EMBED})
    outputs = asyncio.run(tag.run(job, _ctx(context)))
    result = _tag_result(outputs, context)
    assert isinstance(result, TagResult)


def test_tag_refuses_heads_when_none_are_configured() -> None:
    context = FakeContext(Path(), {})
    job = make_job(tag.CAPABILITY, {}, params={"classifier": "heads"})
    with pytest.raises(ValueError, match="no trained heads"):
        asyncio.run(tag.run(job, _ctx(context)))


@needs_ffmpeg
def test_tag_flags_silence_via_the_embedding(tmp_path: Path) -> None:
    silent = wav_bytes(np.zeros(SAMPLE_RATE * 5, dtype=np.float32), SAMPLE_RATE)
    context = FakeContext(tmp_path, {HASH_SOURCE: silent})
    job = make_job(tag.CAPABILITY, {"source": HASH_SOURCE})
    result = _tag_result(asyncio.run(tag.run(job, _ctx(context))), context)
    assert result.lowConfidence is True


@needs_ffmpeg
def test_tag_cancels(tmp_path: Path) -> None:
    context = FakeContext(
        tmp_path,
        {HASH_SOURCE: wav_bytes(sine(4.0, SAMPLE_RATE, 220.0), SAMPLE_RATE)},
        cancel_after=0,
    )
    job = make_job(tag.CAPABILITY, {"source": HASH_SOURCE})
    with pytest.raises(JobCancelledError):
        asyncio.run(tag.run(job, _ctx(context)))
    assert not context.uploads


def test_an_embedding_blob_of_the_wrong_scope_is_rejected(tmp_path: Path) -> None:
    embedding = EmbeddingResult.model_validate(
        {
            "schemaVersion": 1,
            "scope": "stem",
            "model": "mock",
            "dim": 512,
            "vectors": [{"scopeRef": "drums", "vector": [1.0] + [0.0] * 511}],
        }
    )
    context = FakeContext(tmp_path, {HASH_EMBED: embedding.model_dump_json().encode()})
    job = make_job(tag.CAPABILITY, {}, blobs={"embed_full": HASH_EMBED})
    with pytest.raises(ValueError, match="song-scope"):
        asyncio.run(tag.run(job, _ctx(context)))
