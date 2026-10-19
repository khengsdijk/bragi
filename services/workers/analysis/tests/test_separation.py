"""The ``analysis.separation`` capability end to end, with a stub model."""

from __future__ import annotations

import asyncio
import hashlib
from typing import cast

import numpy as np
import pytest

from bragi_analysis.capabilities import separation
from bragi_analysis.separation import pipeline as pl
from bragi_analysis.separation.audio import decode_flac, encode_flac
from bragi_common.cancel import JobCancelledError
from bragi_common.context import JobContext
from bragi_common.generated.models import (
    FreeformParams,
    JobInputs,
    JobPriority,
    JobRequest,
    JobRequestSchemaVersion,
    SeparationResult,
)

RATE = 48_000
MIX_HASH = "sha256:" + "a" * 64


class StubBackend:
    """Three 'stems' at a foreign model rate: loud, quiet and (nearly) silent."""

    sample_rate = 44_100
    max_segment_sec = 7.8
    stem_names = ("drums", "vocals", "piano")

    def __init__(self) -> None:
        self.calls = 0

    def separate(self, chunk: np.ndarray) -> np.ndarray:
        self.calls += 1
        return np.stack([chunk * 0.7, chunk * 0.3, chunk * 1e-5]).astype(np.float32)


class FakeContext:
    def __init__(self, mix_bytes: bytes, cancel_after: int | None = None) -> None:
        self._mix = mix_bytes
        self.store: dict[str, bytes] = {}
        self.reports: list[float] = []
        self._cancel_after = cancel_after
        self._polls = 0

    async def progress(self, pct: float, eta: float | None = None) -> None:
        self.reports.append(pct)

    async def cancelled(self) -> bool:
        self._polls += 1
        return self._cancel_after is not None and self._polls > self._cancel_after

    async def download(self, content_hash: str) -> bytes:
        assert content_hash == MIX_HASH
        return self._mix

    async def upload(self, data: bytes, mime: str | None = None) -> str:
        digest = "sha256:" + hashlib.sha256(data).hexdigest()
        self.store[digest] = data
        return digest

    async def upload_json(self, document: str) -> str:
        return await self.upload(document.encode(), "application/json")


def make_job(params: dict[str, object] | None = None) -> JobRequest:
    return JobRequest(
        schemaVersion=JobRequestSchemaVersion.integer_1,
        jobId="job_01SEP",
        capability=separation.CAPABILITY,
        priority=JobPriority.interactive,
        userId="user_01",
        inputs=JobInputs(
            assets={"mix": MIX_HASH}, params=FreeformParams.model_validate(params or {})
        ),
        idempotencyKey="key",
        attempt=0,
        deadline="2026-10-19T00:00:00.000Z",
        traceparent="00-11111111111111111111111111111111-2222222222222222-01",
        createdAt="2026-10-19T00:00:00.000Z",
    )


@pytest.fixture
def backend(monkeypatch: pytest.MonkeyPatch) -> StubBackend:
    stub = StubBackend()
    monkeypatch.setattr(separation, "backend_factory", lambda model, device: stub)
    monkeypatch.setattr(separation, "_BACKENDS", {})
    return stub


def working_asset(seconds: float) -> tuple[bytes, np.ndarray]:
    n = int(seconds * RATE)
    t = np.arange(n) / RATE
    rng = np.random.default_rng(3)
    left = 0.3 * np.sin(2 * np.pi * 261.6 * t) + 0.05 * rng.standard_normal(n)
    right = 0.3 * np.sin(2 * np.pi * 392.0 * t) + 0.05 * rng.standard_normal(n)
    data = encode_flac(np.stack([left, right]), RATE)
    return data, decode_flac(data)[0]


def test_capability_contract() -> None:
    assert separation.CAPABILITY == "analysis.separation"
    assert separation.ParamsModel().model == "htdemucs_6s"
    with pytest.raises(ValueError, match="extra"):
        separation.ParamsModel.model_validate({"nope": 1})


def test_separation_emits_stems_residual_and_a_valid_result_blob(backend: StubBackend) -> None:
    data, mix = working_asset(20.0)
    ctx = FakeContext(data)
    outputs = asyncio.run(separation.run(make_job(), cast(JobContext, ctx)))

    assert outputs.assets is not None and outputs.blobs is not None
    # The silent third stem is dropped (04 §4), the rest are kept.
    assert sorted(outputs.assets) == ["residual", "stem_drums", "stem_vocals"]
    result = SeparationResult.model_validate_json(ctx.store[outputs.blobs["separation"]])
    assert result.model == "htdemucs_6s-1"
    assert [stem.role.value for stem in result.stems] == ["drums", "vocals"]
    assert result.residual == outputs.assets["residual"]
    assert result.stems[0].rmsDb is not None and result.stems[0].rmsDb > -60.0

    # Acceptance: sum of the stored stems + stored residual nulls against the working mix.
    stems = [decode_flac(ctx.store[outputs.assets[f"stem_{r}"]])[0] for r in ("drums", "vocals")]
    residual, rate = decode_flac(ctx.store[outputs.assets["residual"]])
    assert rate == RATE and residual.shape == mix.shape
    rms, peak = pl.null_db(mix, stems, residual)
    assert rms <= -60.0 and peak <= -60.0
    assert peak <= -120.0  # measured: the 24-bit grid


def test_chunking_follows_the_model_limit_not_the_requested_ten_seconds(
    backend: StubBackend,
) -> None:
    data, _ = working_asset(20.0)
    asyncio.run(separation.run(make_job({"segmentSec": 10.0}), cast(JobContext, FakeContext(data))))
    # 20 s at 44.1 kHz in 7.8 s chunks with 1 s overlap: 3 chunks, not the 3 a 10 s plan would give
    # only by accident; assert the plan itself.
    assert backend.calls == len(pl.plan_chunks(20 * 44_100, int(7.8 * 44_100), 44_100))


def test_progress_is_monotonic_and_reaches_one(backend: StubBackend) -> None:
    data, _ = working_asset(12.0)
    ctx = FakeContext(data)
    asyncio.run(separation.run(make_job(), cast(JobContext, ctx)))
    assert ctx.reports == sorted(ctx.reports)
    assert ctx.reports[-1] == 1.0


def test_cancellation_stops_between_chunks(backend: StubBackend) -> None:
    data, _ = working_asset(20.0)
    ctx = FakeContext(data, cancel_after=1)
    with pytest.raises(JobCancelledError):
        asyncio.run(separation.run(make_job(), cast(JobContext, ctx)))
    assert backend.calls == 1
    assert not ctx.store  # nothing was uploaded


def test_a_silent_file_keeps_one_stem_so_the_result_stays_schema_valid(
    backend: StubBackend,
) -> None:
    silent = encode_flac(np.zeros((2, RATE * 3)), RATE)
    ctx = FakeContext(silent)
    outputs = asyncio.run(separation.run(make_job(), cast(JobContext, ctx)))
    assert outputs.blobs is not None
    result = SeparationResult.model_validate_json(ctx.store[outputs.blobs["separation"]])
    assert len(result.stems) == 1


def test_a_non_working_asset_is_rejected(backend: StubBackend) -> None:
    mono_44k = encode_flac(np.zeros((1, 44_100)), 44_100)
    with pytest.raises(ValueError, match="48 kHz stereo"):
        asyncio.run(separation.run(make_job(), cast(JobContext, FakeContext(mono_44k))))
