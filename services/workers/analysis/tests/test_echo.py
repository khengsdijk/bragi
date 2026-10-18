"""The ``echo`` capability: the acceptance test's stand-in for a real worker."""

from __future__ import annotations

import asyncio
from typing import cast

import pytest

from bragi_analysis.capabilities import echo
from bragi_common.cancel import JobCancelledError
from bragi_common.context import JobContext
from bragi_common.generated.models import (
    FreeformParams,
    JobInputs,
    JobPriority,
    JobRequest,
    JobRequestSchemaVersion,
)

TRACEPARENT = "00-11111111111111111111111111111111-2222222222222222-01"
INPUT_HASH = "sha256:" + "a" * 64
MANIFEST_HASH = "sha256:" + "b" * 64


class FakeContext:
    def __init__(self, cancelled: bool = False) -> None:
        self.reports: list[float] = []
        self.downloaded: list[str] = []
        self.uploaded: list[str] = []
        self._cancelled = cancelled

    async def progress(self, pct: float, eta: float | None = None) -> None:
        self.reports.append(pct)

    async def cancelled(self) -> bool:
        return self._cancelled

    async def download(self, content_hash: str) -> bytes:
        self.downloaded.append(content_hash)
        return b"audio"

    async def upload_json(self, document: str) -> str:
        self.uploaded.append(document)
        return MANIFEST_HASH


def make_job(params: dict[str, object]) -> JobRequest:
    return JobRequest(
        schemaVersion=JobRequestSchemaVersion.integer_1,
        jobId="job_01ABC",
        capability="echo",
        priority=JobPriority.interactive,
        userId="user_01",
        inputs=JobInputs(
            assets={"source": INPUT_HASH}, params=FreeformParams.model_validate(params)
        ),
        idempotencyKey="key",
        attempt=0,
        deadline="2026-10-18T00:00:00.000Z",
        traceparent=TRACEPARENT,
        createdAt="2026-10-18T00:00:00.000Z",
    )


def test_capability_name_and_params_contract() -> None:
    assert echo.CAPABILITY == "echo"
    assert echo.ParamsModel.model_validate({"steps": 2, "delay_ms": 5}).steps == 2


def test_run_reports_progress_downloads_inputs_and_uploads_a_manifest() -> None:
    context = FakeContext()
    outputs = asyncio.run(echo.run(make_job({"steps": 3}), cast(JobContext, context)))

    assert context.reports == [1 / 3, 2 / 3, 1.0]
    assert context.downloaded == [INPUT_HASH]
    assert outputs.assets == {"source": INPUT_HASH}
    assert outputs.blobs == {"manifest": MANIFEST_HASH}
    assert "echo" in context.uploaded[0]


def test_run_raises_when_cancelled_before_finishing() -> None:
    context = FakeContext(cancelled=True)
    with pytest.raises(JobCancelledError):
        asyncio.run(echo.run(make_job({"steps": 3}), cast(JobContext, context)))
