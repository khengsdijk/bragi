"""The three ``embed_*`` capabilities end to end, with a fake context (04 §6.1)."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import cast

import numpy as np
import pytest
from embedding_support import (
    HASH_ACTIVITY,
    HASH_BASS,
    HASH_DRUMS,
    HASH_OTHER,
    HASH_SOURCE,
    HASH_STRUCTURE,
    HASH_VOCALS,
    FakeContext,
    FakeStore,
    make_job,
    needs_ffmpeg,
    sine,
    synthetic_stems,
    wav_bytes,
)

from bragi_analysis.capabilities import embed_full, section_embed, stem_embed
from bragi_analysis.embedding import store
from bragi_analysis.embedding.fallback import FallbackEmbedder
from bragi_common.cancel import JobCancelledError
from bragi_common.context import JobContext
from bragi_common.generated.models import EmbeddingResult, EmbeddingScope, JobOutputs

SAMPLE_RATE = 22_050


def _ctx(context: FakeContext) -> JobContext:
    return cast(JobContext, context)


def _result(outputs: JobOutputs, context: FakeContext, key: str) -> EmbeddingResult:
    assert outputs.blobs is not None and key in outputs.blobs
    return EmbeddingResult.model_validate_json(context.uploads[outputs.blobs[key]])


def test_contracts_and_registration() -> None:
    assert embed_full.CAPABILITY == "analysis.embed_full"
    assert section_embed.CAPABILITY == "analysis.section_embed"
    assert stem_embed.CAPABILITY == "analysis.stem_embed"
    assert embed_full.ParamsModel().embedder == "auto"
    assert embed_full.ParamsModel().storeEmbeddings is False
    from bragi_analysis import worker

    for module in (embed_full, section_embed, stem_embed):
        assert module in worker.CAPABILITIES


@needs_ffmpeg
def test_embed_full_publishes_a_song_vector(tmp_path: Path) -> None:
    audio = synthetic_stems(SAMPLE_RATE, 6.0)["other"]
    context = FakeContext(tmp_path, {HASH_SOURCE: wav_bytes(audio.astype(np.float32), SAMPLE_RATE)})
    job = make_job(embed_full.CAPABILITY, {"source": HASH_SOURCE})
    outputs = asyncio.run(embed_full.run(job, _ctx(context)))
    result = _result(outputs, context, "embed_full")

    assert result.scope == EmbeddingScope.song
    assert result.model == "bragi-concept-basis-1"
    assert result.dim == 512
    assert len(result.vectors) == 1
    assert result.vectors[0].scopeRef is None
    assert float(np.linalg.norm(result.vectors[0].vector)) == pytest.approx(1.0)
    assert result.lowConfidence is None
    assert context.reports == sorted(context.reports)
    assert context.reports[-1] == 1.0


@needs_ffmpeg
def test_embed_full_flags_and_normalises_silence(tmp_path: Path) -> None:
    silent = np.zeros(SAMPLE_RATE * 5, dtype=np.float32)
    context = FakeContext(tmp_path, {HASH_SOURCE: wav_bytes(silent, SAMPLE_RATE)})
    job = make_job(embed_full.CAPABILITY, {"source": HASH_SOURCE})
    outputs = asyncio.run(embed_full.run(job, _ctx(context)))
    result = _result(outputs, context, "embed_full")
    assert result.lowConfidence is True
    assert float(np.linalg.norm(result.vectors[0].vector)) == pytest.approx(1.0)


@needs_ffmpeg
def test_section_embed_uses_the_structure_blob(tmp_path: Path) -> None:
    audio = wav_bytes(synthetic_stems(SAMPLE_RATE, 6.0)["other"].astype(np.float32), SAMPLE_RATE)
    structure = {
        "schemaVersion": 1,
        "sections": [
            {"startSec": 0.0, "endSec": 3.0, "kind": "verse", "confidence": 0.9},
            {"startSec": 3.0, "endSec": 6.0, "kind": "chorus", "confidence": 0.9},
        ],
    }
    context = FakeContext(
        tmp_path, {HASH_SOURCE: audio, HASH_STRUCTURE: json.dumps(structure).encode()}
    )
    job = make_job(
        section_embed.CAPABILITY, {"source": HASH_SOURCE}, blobs={"structure": HASH_STRUCTURE}
    )
    outputs = asyncio.run(section_embed.run(job, _ctx(context)))
    result = _result(outputs, context, "section_embed")

    assert result.scope == EmbeddingScope.section
    assert [entry.scopeRef for entry in result.vectors] == ["0", "1"]
    assert all(float(np.linalg.norm(e.vector)) == pytest.approx(1.0) for e in result.vectors)
    assert result.lowConfidence is None


@needs_ffmpeg
def test_section_embed_without_structure_degrades(tmp_path: Path) -> None:
    audio = wav_bytes(sine(4.0, SAMPLE_RATE, 220.0), SAMPLE_RATE)
    context = FakeContext(tmp_path, {HASH_SOURCE: audio})
    job = make_job(section_embed.CAPABILITY, {"source": HASH_SOURCE})
    outputs = asyncio.run(section_embed.run(job, _ctx(context)))
    result = _result(outputs, context, "section_embed")
    assert result.vectors == []
    assert result.lowConfidence is True


@needs_ffmpeg
def test_stem_embed_publishes_one_vector_per_stem(tmp_path: Path) -> None:
    stems = synthetic_stems(SAMPLE_RATE, 6.0)
    sources = {
        HASH_DRUMS: wav_bytes(stems["drums"], SAMPLE_RATE),
        HASH_BASS: wav_bytes(stems["bass"], SAMPLE_RATE),
        HASH_VOCALS: wav_bytes(stems["vocals"], SAMPLE_RATE),
        HASH_OTHER: wav_bytes(stems["other"], SAMPLE_RATE),
        HASH_ACTIVITY: json.dumps(
            {
                "schemaVersion": 1,
                "stems": [
                    {"role": "drums", "active": [{"startSec": 0.0, "endSec": 6.0}], "presence": []},
                    {"role": "bass", "active": [{"startSec": 0.0, "endSec": 1.0}], "presence": []},
                ],
            }
        ).encode(),
    }
    context = FakeContext(tmp_path, sources)
    job = make_job(
        stem_embed.CAPABILITY,
        {
            "stem_drums": HASH_DRUMS,
            "stem_bass": HASH_BASS,
            "stem_vocals": HASH_VOCALS,
            "stem_other": HASH_OTHER,
        },
        blobs={"stem_activity": HASH_ACTIVITY},
    )
    outputs = asyncio.run(stem_embed.run(job, _ctx(context)))
    result = _result(outputs, context, "stem_embed")

    assert result.scope == EmbeddingScope.stem
    assert {entry.scopeRef for entry in result.vectors} == {"drums", "bass", "vocals", "other"}
    assert result.lowConfidence is None
    query = FallbackEmbedder().embed_texts(["drums"])[0]
    cosine = {entry.scopeRef: float(query @ np.asarray(entry.vector)) for entry in result.vectors}
    assert max(cosine, key=lambda role: cosine[role]) == "drums"


@needs_ffmpeg
def test_store_embeddings_writes_when_asked(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    audio = wav_bytes(sine(4.0, SAMPLE_RATE, 220.0), SAMPLE_RATE)
    context = FakeContext(tmp_path, {HASH_SOURCE: audio})
    fake = FakeStore()

    async def fake_open_store(dsn: str | None = None) -> FakeStore:
        return fake

    monkeypatch.setattr(store, "open_store", fake_open_store)
    job = make_job(embed_full.CAPABILITY, {"source": HASH_SOURCE}, params={"storeEmbeddings": True})
    asyncio.run(embed_full.run(job, _ctx(context)))
    assert len(fake.rows) == 1
    assert fake.rows[0].scope == "song" and fake.rows[0].asset_hash == HASH_SOURCE
    assert fake.closed


@needs_ffmpeg
def test_store_embeddings_is_off_by_default(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    audio = wav_bytes(sine(4.0, SAMPLE_RATE, 220.0), SAMPLE_RATE)
    context = FakeContext(tmp_path, {HASH_SOURCE: audio})

    async def fake_open_store(dsn: str | None = None) -> FakeStore:  # pragma: no cover
        raise AssertionError("the store must not be opened when the flag is off")

    monkeypatch.setattr(store, "open_store", fake_open_store)
    job = make_job(embed_full.CAPABILITY, {"source": HASH_SOURCE})
    asyncio.run(embed_full.run(job, _ctx(context)))


@needs_ffmpeg
def test_embed_full_cancels(tmp_path: Path) -> None:
    audio = wav_bytes(sine(4.0, SAMPLE_RATE, 220.0), SAMPLE_RATE)
    context = FakeContext(tmp_path, {HASH_SOURCE: audio}, cancel_after=0)
    job = make_job(embed_full.CAPABILITY, {"source": HASH_SOURCE})
    with pytest.raises(JobCancelledError):
        asyncio.run(embed_full.run(job, _ctx(context)))
    assert not context.uploads
