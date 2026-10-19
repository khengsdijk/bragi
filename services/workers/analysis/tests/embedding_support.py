"""Shared fixtures for the WP-1.6 tests: fake contexts, synthetic stems, a fake store."""

from __future__ import annotations

import hashlib
import shutil
from collections.abc import Sequence
from pathlib import Path

import numpy as np
import pytest

from bragi_analysis.embedding import store as embedding_store
from bragi_common.generated.models import (
    FreeformParams,
    JobInputs,
    JobPriority,
    JobRequest,
    JobRequestSchemaVersion,
)

TRACEPARENT = "00-11111111111111111111111111111111-2222222222222222-01"

HASH_SOURCE = "sha256:" + "a" * 64
HASH_DRUMS = "sha256:" + "b" * 64
HASH_BASS = "sha256:" + "c" * 64
HASH_VOCALS = "sha256:" + "d" * 64
HASH_OTHER = "sha256:" + "e" * 64
HASH_STRUCTURE = "sha256:" + "f" * 64
HASH_ACTIVITY = "sha256:" + "0" * 64
HASH_EMBED = "sha256:" + "1" * 64

needs_ffmpeg = pytest.mark.skipif(
    shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None,
    reason="ffmpeg/ffprobe are not on PATH (see services/workers/Dockerfile)",
)


class FakeContext:
    """The slice of ``JobContext`` the WP-1.6 capabilities use, with per-hash audio."""

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


class FakeStore:
    """An in-memory :class:`EmbeddingStore` that records what was written."""

    def __init__(self) -> None:
        self.rows: list[embedding_store.EmbeddingRow] = []
        self.closed = False

    async def upsert(self, rows: Sequence[embedding_store.EmbeddingRow]) -> int:
        self.rows.extend(rows)
        return len(rows)

    async def close(self) -> None:
        self.closed = True


class FakePool:
    """The subset of an asyncpg pool :class:`PgVectorStore` uses."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, list[tuple[object, ...]]]] = []
        self.closed = False

    async def executemany(self, sql: str, params: Sequence[Sequence[object]]) -> None:
        self.calls.append((sql, [tuple(p) for p in params]))

    async def close(self) -> None:
        self.closed = True


def make_job(
    capability: str,
    assets: dict[str, str],
    blobs: dict[str, str] | None = None,
    params: dict[str, object] | None = None,
) -> JobRequest:
    """A ``JobRequest`` for one capability with the given assets/blobs/params."""
    return JobRequest(
        schemaVersion=JobRequestSchemaVersion.integer_1,
        jobId="job_01EMBED",
        capability=capability,
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
        traceparent=TRACEPARENT,
        createdAt="2026-10-19T00:00:00.000Z",
    )


def wav_bytes(samples: np.ndarray, sample_rate: int) -> bytes:
    """A 16-bit PCM WAV of float samples shaped ``(n,)`` or ``(n, channels)``."""
    import io
    import wave

    data = samples if samples.ndim == 2 else samples[:, None]
    pcm = np.clip(np.round(data * 32767), -32768, 32767).astype("<i2")
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as writer:
        writer.setnchannels(data.shape[1])
        writer.setsampwidth(2)
        writer.setframerate(sample_rate)
        writer.writeframes(pcm.tobytes())
    return buffer.getvalue()


def sine(seconds: float, sample_rate: int, hz: float, amplitude: float = 0.5) -> np.ndarray:
    """A pure tone."""
    t = np.arange(round(seconds * sample_rate)) / sample_rate
    return (amplitude * np.sin(2 * np.pi * hz * t)).astype(np.float32)


def click_train(seconds: float, sample_rate: int, per_second: float = 3.0) -> np.ndarray:
    """A deterministic percussive signal: short filtered noise bursts."""
    rng = np.random.default_rng(1)
    out = np.zeros(round(seconds * sample_rate), dtype=np.float32)
    burst = int(0.01 * sample_rate)
    for index in range(int(seconds * per_second)):
        start = int(index * sample_rate / per_second)
        noise = rng.standard_normal(burst).astype(np.float32)
        out[start : start + burst] += noise * 0.5
    return out


def synthetic_stems(sample_rate: int, seconds: float) -> dict[str, np.ndarray]:
    """A hand-made drum/bass/vocal/chord quartet (licence-free, generated)."""
    return {
        "drums": click_train(seconds, sample_rate),
        "bass": sine(seconds, sample_rate, 55.0, 0.6),
        "vocals": sine(seconds, sample_rate, 440.0, 0.5),
        "other": sine(seconds, sample_rate, 330.0, 0.3) + sine(seconds, sample_rate, 392.0, 0.3),
    }
