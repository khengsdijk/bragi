"""Shared fixtures: a fake job context and generated, licence-clean audio.

Every signal here is synthesised by the test (sines, noise, click tracks), so no
audio file is checked in (13 §1.7).
"""

from __future__ import annotations

import hashlib
import io
import shutil
import wave
from pathlib import Path

import numpy as np
import pytest

from bragi_common.generated.models import (
    FreeformParams,
    JobInputs,
    JobPriority,
    JobRequest,
    JobRequestSchemaVersion,
)

TRACEPARENT = "00-11111111111111111111111111111111-2222222222222222-01"
SOURCE_HASH = "sha256:" + "a" * 64

needs_ffmpeg = pytest.mark.skipif(
    shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None,
    reason="ffmpeg/ffprobe are not on PATH (see services/workers/Dockerfile)",
)
needs_fpcalc = pytest.mark.skipif(shutil.which("fpcalc") is None, reason="fpcalc is not on PATH")


class FakeContext:
    """The slice of ``JobContext`` the analysis capabilities use."""

    def __init__(self, scratch: Path, source: bytes = b"", *, cancelled: bool = False) -> None:
        self.scratch = scratch
        self.source = source
        self.reports: list[float] = []
        self.uploads: dict[str, bytes] = {}
        self._cancelled = cancelled

    def scratch_path(self, name: str) -> Path:
        return self.scratch / name

    async def progress(self, pct: float, eta: float | None = None) -> None:
        self.reports.append(pct)

    async def cancelled(self) -> bool:
        return self._cancelled

    async def download(self, content_hash: str) -> bytes:
        return self.source

    async def upload(self, data: bytes, mime: str | None = None) -> str:
        key = "sha256:" + hashlib.sha256(data).hexdigest()
        self.uploads[key] = data
        return key

    async def upload_json(self, document: str) -> str:
        return await self.upload(document.encode(), "application/json")


def make_job(
    capability: str, params: dict[str, object] | None = None, source: str = SOURCE_HASH
) -> JobRequest:
    return JobRequest(
        schemaVersion=JobRequestSchemaVersion.integer_1,
        jobId="job_01ABC",
        capability=capability,
        priority=JobPriority.interactive,
        userId="user_01",
        inputs=JobInputs(
            assets={"source": source}, params=FreeformParams.model_validate(params or {})
        ),
        idempotencyKey="key",
        attempt=0,
        deadline="2026-10-18T00:00:00.000Z",
        traceparent=TRACEPARENT,
        createdAt="2026-10-18T00:00:00.000Z",
    )


def wav_bytes(samples: np.ndarray, sample_rate: int) -> bytes:
    """A 16-bit PCM WAV of float samples shaped ``(n,)`` or ``(n, channels)``."""
    data = samples if samples.ndim == 2 else samples[:, None]
    pcm = np.clip(np.round(data * 32767), -32768, 32767).astype("<i2")
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as writer:
        writer.setnchannels(data.shape[1])
        writer.setsampwidth(2)
        writer.setframerate(sample_rate)
        writer.writeframes(pcm.tobytes())
    return buffer.getvalue()


def sine(seconds: float, sample_rate: int, hz: float = 440.0, amplitude: float = 0.5) -> np.ndarray:
    t = np.arange(round(seconds * sample_rate)) / sample_rate
    return (amplitude * np.sin(2 * np.pi * hz * t)).astype(np.float32)
