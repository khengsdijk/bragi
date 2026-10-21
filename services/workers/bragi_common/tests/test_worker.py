"""The worker's pure helpers and the params flattening."""

from __future__ import annotations

from pathlib import Path
from typing import cast

from nats.aio.msg import Msg

from bragi_common.cancel import CancelToken
from bragi_common.context import JobContext
from bragi_common.errors import JobFailure
from bragi_common.generated.models import (
    FreeformParams,
    JobEventType,
    JobInputs,
    JobMetrics,
    JobOutputs,
    JobPriority,
    JobRequest,
    JobRequestSchemaVersion,
)
from bragi_common.progress import ProgressReporter
from bragi_common.protocol import params_of
from bragi_common.s3 import ObjectStore
from bragi_common.worker import _error_code, _event, _num_delivered, _retryable

TRACEPARENT = "00-11111111111111111111111111111111-2222222222222222-01"


def make_job(params: dict[str, object] | None = None) -> JobRequest:
    return JobRequest(
        schemaVersion=JobRequestSchemaVersion.integer_1,
        jobId="job_01ABC",
        capability="echo",
        priority=JobPriority.interactive,
        userId="user_01",
        inputs=JobInputs(assets={}, params=FreeformParams.model_validate(params or {})),
        idempotencyKey="key",
        attempt=0,
        deadline="2026-10-18T00:00:00.000Z",
        traceparent=TRACEPARENT,
        createdAt="2026-10-18T00:00:00.000Z",
    )


def test_params_of_flattens_the_freeform_model() -> None:
    assert params_of(make_job({"steps": 4, "delay_ms": 10})) == {"steps": 4, "delay_ms": 10}


def test_event_only_carries_the_fields_that_are_set() -> None:
    job = make_job()
    progress = _event(job, JobEventType.progress, pct=0.5)
    assert progress.model_dump(exclude_none=True) == {
        "schemaVersion": 1,
        "jobId": "job_01ABC",
        "type": "progress",
        "pct": 0.5,
    }
    assert _event(job, JobEventType.started).type is JobEventType.started


def test_completed_carries_the_metrics_a_capability_records() -> None:
    job = make_job()
    metrics = JobMetrics(
        gpuSeconds=12.5, model="ace-step", modelVersion="1.5.0", worker="bragi-generate:ace_step"
    )
    event = _event(job, JobEventType.completed, metrics=metrics)
    assert event.model_dump(exclude_none=True)["metrics"] == {
        "gpuSeconds": 12.5,
        "model": "ace-step",
        "modelVersion": "1.5.0",
        "worker": "bragi-generate:ace_step",
    }


def test_the_context_records_metrics_for_the_completed_event() -> None:
    async def no_partial(_outputs: JobOutputs) -> None:
        return None

    context = JobContext(
        job=make_job(),
        store=cast(ObjectStore, object()),
        reporter=cast(ProgressReporter, object()),
        cancel=cast(CancelToken, object()),
        scratch=Path(),
        publish_partial=no_partial,
    )
    metrics = JobMetrics(
        gpuSeconds=1.0, model="fake", modelVersion="1", worker="bragi-generate:fake"
    )
    assert context.metrics is None
    context.record_metrics(metrics)
    assert context.metrics == metrics


def test_error_code_reads_a_domain_code_and_falls_back() -> None:
    class CodedError(Exception):
        code = "INGEST_FAILED"

    assert _error_code(CodedError("x")) == "INGEST_FAILED"
    assert _error_code(ValueError("x")) == "MODEL_ERROR"


def test_num_delivered_reads_metadata_with_a_safe_default() -> None:
    class Metadata:
        num_delivered = 4

    class Message:
        metadata = Metadata()

    assert _num_delivered(cast(Msg, Message())) == 4
    assert _num_delivered(cast(Msg, object())) == 1


def test_job_failure_carries_a_code_and_is_not_retried_by_default() -> None:
    failure = JobFailure("ASSET_CORRUPT", "damaged")
    assert _error_code(failure) == "ASSET_CORRUPT"
    assert _retryable(failure) is False
    assert _retryable(JobFailure("MODEL_ERROR", "flaky", retryable=True)) is True


def test_an_unexpected_exception_is_retryable() -> None:
    assert _retryable(RuntimeError("boom")) is True
