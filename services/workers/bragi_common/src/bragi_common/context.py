"""The ``ctx`` a capability is handed (``specs/13`` §3 ``run(job, ctx)``).

It is the whole surface a capability gets: progress, cancellation, content
-addressed IO, a scratch directory, and partial output. Nothing else.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from pathlib import Path

from bragi_common.cancel import CancelToken
from bragi_common.generated.models import JobMetrics, JobOutputs, JobRequest
from bragi_common.progress import ProgressReporter
from bragi_common.s3 import ObjectStore


class JobContext:
    """The capability-facing half of the worker framework."""

    def __init__(
        self,
        *,
        job: JobRequest,
        store: ObjectStore,
        reporter: ProgressReporter,
        cancel: CancelToken,
        scratch: Path,
        publish_partial: Callable[[JobOutputs], Awaitable[None]],
    ) -> None:
        """Stores the per-job collaborators."""
        self._job = job
        self._store = store
        self._reporter = reporter
        self._cancel = cancel
        self._scratch = scratch
        self._publish_partial = publish_partial
        self._metrics: JobMetrics | None = None

    @property
    def job(self) -> JobRequest:
        """The request being executed."""
        return self._job

    @property
    def metrics(self) -> JobMetrics | None:
        """The metrics a capability recorded, published with ``completed`` (05 §4.2)."""
        return self._metrics

    def record_metrics(self, metrics: JobMetrics) -> None:
        """Records the run's cost and provenance for the ``completed`` event."""
        self._metrics = metrics

    @property
    def scratch(self) -> Path:
        """A per-job scratch directory that exists and is empty at the start."""
        return self._scratch

    def scratch_path(self, name: str) -> Path:
        """A path inside the scratch directory."""
        return self._scratch / name

    async def progress(self, pct: float, eta_sec: float | None = None) -> None:
        """Reports progress in 0..1 (throttled to 2/s, 05 §4.3)."""
        await self._reporter.report(pct, eta_sec)

    async def partial(self, outputs: JobOutputs) -> None:
        """Publishes an intermediate result as a ``partial`` event (05 §4.3)."""
        await self._publish_partial(outputs)

    async def cancelled(self) -> bool:
        """True when ``DELETE /jobs/{id}`` has set the cancel flag (05 §4.4)."""
        return await self._cancel.cancelled()

    async def download(self, content_hash: str) -> bytes:
        """Downloads an input, verifying its content address (05 §4.3)."""
        return await self._store.download(content_hash)

    async def upload(self, data: bytes, mime: str | None = None) -> str:
        """Uploads a content-addressed output and returns its hash (05 §4.3)."""
        return await self._store.upload(data, mime)

    async def upload_json(self, document: str) -> str:
        """Uploads a JSON output blob."""
        return await self._store.upload_json(document)
