"""Shared framework for every Bragi worker.

Provides the parts that no capability should reimplement: the NATS JetStream
client and job protocol, the result cache, S3 input/output, progress reporting,
cancellation and the Pydantic v2 models generated from ``packages/schemas``
(``specs/05-backend-and-jobs.md``).

A worker capability is a module exposing ``CAPABILITY``, ``ParamsModel`` and
``run(job, ctx) -> Outputs``; this framework handles everything else. It is held
to ``mypy --strict`` (``specs/13-agent-guide.md`` §3).

Example:
    >>> from bragi_common.config import Settings
    >>> from bragi_common.worker import run_worker
    >>> run_worker(Settings(), [echo_capability])  # doctest: +SKIP

Status:
    Built by **WP-0.7**, together with an ``echo`` capability and OpenTelemetry
    tracing from API through NATS to worker.
"""

from bragi_common.cache import ResultCache
from bragi_common.cancel import CancelToken, JobCancelledError
from bragi_common.config import Settings
from bragi_common.context import JobContext
from bragi_common.hashes import asset_hash, is_asset_hash, key_for
from bragi_common.protocol import Capability, Outputs
from bragi_common.s3 import HashMismatchError, ObjectStore
from bragi_common.telemetry import context_from_traceparent, setup_telemetry, shutdown_telemetry
from bragi_common.worker import Worker, run_worker

__all__ = [
    "CancelToken",
    "Capability",
    "HashMismatchError",
    "JobCancelledError",
    "JobContext",
    "ObjectStore",
    "Outputs",
    "ResultCache",
    "Settings",
    "Worker",
    "asset_hash",
    "context_from_traceparent",
    "is_asset_hash",
    "key_for",
    "run_worker",
    "setup_telemetry",
    "shutdown_telemetry",
]
