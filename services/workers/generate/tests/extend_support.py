"""Shared fixtures for the generation capability tests (13 §1.7: signals in code)."""

from __future__ import annotations

import asyncio
import hashlib
from collections.abc import Callable, Coroutine
from typing import Any

import numpy as np

from bragi_common.generated.models import (
    FreeformParams,
    JobInputs,
    JobMetrics,
    JobOutputs,
    JobPriority,
    JobRequest,
    JobRequestSchemaVersion,
)
from bragi_generate.audio import encode_wav
from bragi_generate.backend import GenOutput, GenRequest, GenTimings, Tier
from bragi_generate.backends.fake import synthesize
from bragi_generate.postprocess import Audio, GateResult, KeySpec, StepVerdict

SAMPLE_RATE = 48_000
CONTEXT_HASH = "sha256:" + "c" * 64


def run_async[T](coroutine: Coroutine[Any, Any, T]) -> T:
    """Runs a coroutine to completion without an async test plugin."""
    return asyncio.run(coroutine)


def key() -> KeySpec:
    """A minor, the key every fixture is built in."""
    return KeySpec.parse("A", "minor")


def context_audio(seconds: float = 12.0, *, seed: int = 99) -> Audio:
    """A synthetic context at 120 BPM in A minor."""
    return synthesize(120.0, (4, 4), key(), start_sec=0.0, duration_sec=seconds, seed=seed)


def context_bytes(seconds: float = 12.0) -> bytes:
    """The same context as a 48 kHz WAV, the job input's payload."""
    return encode_wav(context_audio(seconds))


def params(
    *,
    bars: int = 1,
    overlap_bars: int = 1,
    direction: str = "forward",
    tier: str = "preview",
    n: int = 1,
    seed: int = 1234,
) -> dict[str, object]:
    """One valid ``generate.extend`` params document."""
    return {
        "context": {
            "bpm": 120,
            "timeSignature": [4, 4],
            "key": {"tonic": "A", "mode": "minor"},
            "descriptors": ["warm analog synths"],
            "seed": seed,
        },
        "bars": bars,
        "overlapBars": overlap_bars,
        "direction": direction,
        "tier": tier,
        "n": n,
    }


def make_job(params_document: dict[str, object]) -> JobRequest:
    """A ``generate.extend`` job with the fixture context."""
    return JobRequest(
        schemaVersion=JobRequestSchemaVersion.integer_1,
        jobId="job_01EXT",
        capability="generate.extend",
        priority=JobPriority.interactive,
        userId="user_01",
        inputs=JobInputs(
            assets={"context": CONTEXT_HASH},
            params=FreeformParams.model_validate(params_document),
        ),
        idempotencyKey="key",
        attempt=0,
        deadline="2026-10-21T00:00:00.000Z",
        traceparent="00-11111111111111111111111111111111-2222222222222222-01",
        createdAt="2026-10-21T00:00:00.000Z",
    )


class FakeContext:
    """A ``JobContext`` stand-in that records every side effect."""

    def __init__(self, data: bytes, *, cancel_after: int | None = None) -> None:
        self._data = data
        self._cancel_after = cancel_after
        self._polls = 0
        self.uploads: dict[str, bytes] = {}
        self.partials: list[JobOutputs] = []
        self.reports: list[float] = []
        self.metrics: JobMetrics | None = None

    async def progress(self, pct: float, eta_sec: float | None = None) -> None:
        del eta_sec
        self.reports.append(pct)

    async def cancelled(self) -> bool:
        self._polls += 1
        return self._cancel_after is not None and self._polls > self._cancel_after

    async def download(self, content_hash: str) -> bytes:
        assert content_hash == CONTEXT_HASH
        return self._data

    async def upload(self, data: bytes, mime: str | None = None) -> str:
        del mime
        digest = "sha256:" + hashlib.sha256(data).hexdigest()
        self.uploads[digest] = data
        return digest

    async def upload_json(self, document: str) -> str:
        return await self.upload(document.encode(), "application/json")

    async def partial(self, outputs: JobOutputs) -> None:
        self.partials.append(outputs)

    def record_metrics(self, metrics: JobMetrics) -> None:
        self.metrics = metrics


class StubBackend:
    """A backend that returns one short synthetic candidate per call."""

    name = "fake"
    version = "1"
    capabilities = frozenset({"generate.extend"})
    max_duration_sec = 600.0
    supports_audio_context = True
    supports_lyrics = False
    supports_preview_tier = True

    def __init__(self) -> None:
        self.seeds: list[int] = []
        self.seen: list[GenRequest] = []
        self.warms = 0

    def warmup(self) -> None:
        self.warms += 1

    def generate(
        self,
        req: GenRequest,
        tier: Tier,
        n: int,
        on_progress: Callable[[float], None],
    ) -> list[GenOutput]:
        del tier
        assert n == 1
        self.seeds.append(req.seed)
        self.seen.append(req)
        # A silent buffer is enough: the tests substitute run_gates or use the real
        # gates only with the real FakeBackend.
        frames = round(req.total_duration_sec * SAMPLE_RATE)
        audio = Audio(np.zeros((frames, 2), dtype=np.float32), SAMPLE_RATE)
        on_progress(1.0)
        return [
            GenOutput(
                audio=audio,
                seed=req.seed,
                model=self.name,
                model_version=self.version,
                timings=GenTimings(generate_sec=0.01, download_sec=0.0, total_sec=0.01),
            )
        ]


def gate(candidate: Audio, *, passed: bool, seam: float = 0.2) -> GateResult:
    """A one-step gate result that mirrors a real pipeline's shape."""
    return GateResult(
        processed=candidate,
        passed=passed,
        steps=(
            StepVerdict(
                "sanity",
                passed,
                {"peak": 0.5},
                None if passed else "silent",
            ),
        ),
        quality_warning=not passed,
        seam_score=seam,
        tempo_error=0.01,
        key_match=None,
        match_eq=None,
        splice_offset_samples=-256,
        direction="forward",
    )
