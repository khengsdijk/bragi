"""A local ``JobContext`` for the bench: no NATS, no S3, nothing but the capability.

A capability talks to the outside world only through ``ctx`` (05 §4.3), so a bench
run exercises the real capability, routing and gates with this context in place of
the worker framework: downloads come from the rendered fixture, uploads go to an
in-memory content-addressed map, and partials are timestamped so the report can
measure the time to the first passing candidate.

``assets`` is one payload (extend's context) or a name → payload map (a fill's
``before`` and ``after``); the context stores them by content address, exactly like
the object store.
"""

from __future__ import annotations

import hashlib
import time
from collections.abc import Mapping
from dataclasses import dataclass

from bragi_common.generated.models import JobMetrics, JobOutputs


@dataclass(frozen=True)
class PublishedPartial:
    """A ``partial`` the capability published, with its arrival time."""

    outputs: JobOutputs
    at_sec: float


class BenchContext:
    """The capability-facing half of the worker framework, in memory."""

    def __init__(
        self,
        assets: bytes | Mapping[str, bytes],
        *,
        started: float | None = None,
    ) -> None:
        """Stores the input payloads; ``started`` anchors the partial timestamps."""
        payloads = {"context": assets} if isinstance(assets, bytes) else dict(assets)
        if not payloads:
            raise ValueError("a bench context needs at least one input asset")
        self._payloads = {
            "sha256:" + hashlib.sha256(payload).hexdigest(): payload
            for payload in payloads.values()
        }
        self._started = time.perf_counter() if started is None else started
        self._metrics: JobMetrics | None = None
        #: Every upload by hash, exactly what the worker's object store would hold.
        self.uploads: dict[str, bytes] = {}
        #: Every ``partial`` the capability published, in order.
        self.partials: list[PublishedPartial] = []
        #: Every progress report, for debugging a hung run.
        self.progress_events: list[tuple[float, float | None]] = []

    @property
    def metrics(self) -> JobMetrics | None:
        """The metrics the capability recorded (gpu seconds, model, version)."""
        return self._metrics

    def record_metrics(self, metrics: JobMetrics) -> None:
        """Records the run's cost and provenance (05 §4.2)."""
        self._metrics = metrics

    async def progress(self, pct: float, eta_sec: float | None = None) -> None:
        """Records progress in 0..1."""
        self.progress_events.append((pct, eta_sec))

    async def partial(self, outputs: JobOutputs) -> None:
        """Records a partial output and when it arrived."""
        self.partials.append(PublishedPartial(outputs, time.perf_counter() - self._started))

    async def cancelled(self) -> bool:
        """The bench never cancels; a cancelled run is an interrupted command."""
        return False

    async def download(self, content_hash: str) -> bytes:
        """Returns an input payload, verifying its content address like the store."""
        try:
            return self._payloads[content_hash]
        except KeyError as error:
            known = ", ".join(sorted(self._payloads))
            raise ValueError(f"bench has no asset {content_hash} (known: {known})") from error

    async def upload(self, data: bytes, mime: str | None = None) -> str:
        """Stores an output under its content address and returns the hash."""
        del mime
        digest = "sha256:" + hashlib.sha256(data).hexdigest()
        self.uploads[digest] = data
        return digest

    async def upload_json(self, document: str) -> str:
        """Stores a JSON output blob."""
        return await self.upload(document.encode("utf-8"), "application/json")


__all__ = ["BenchContext", "PublishedPartial"]
