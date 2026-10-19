"""The worker loop: the six steps of ``specs/05`` §4.3.

1. Pull a message (interactive subjects are polled first).
2. Check the result cache; on a hit, publish ``completed`` immediately.
3. Download inputs (verifying hashes).
4. Run, publishing ``progress``/``partial`` and in-progress acks.
5. Upload outputs, publish ``completed``, ack.
6. On exception, publish ``failed{retryable}`` (a NAK is the retry).

Workers are stateless and handle SIGTERM gracefully (05 §4.3).
"""

from __future__ import annotations

import asyncio
import logging
import signal
from collections.abc import Sequence
from pathlib import Path

import asyncpg
import nats
from nats.aio.client import Client as NatsClient
from nats.aio.msg import Msg
from nats.js.client import JetStreamContext
from nats.js.kv import KeyValue
from opentelemetry.trace import SpanKind, Tracer

from bragi_common.cache import ResultCache
from bragi_common.cancel import CancelToken, JobCancelledError
from bragi_common.errors import JobFailure
from bragi_common.config import Settings
from bragi_common.context import JobContext
from bragi_common.generated.models import (
    JobError,
    JobEvent,
    JobEventSchemaVersion,
    JobEventType,
    JobOutputs,
    JobRequest,
)
from bragi_common.logging import configure_logging
from bragi_common.progress import ProgressReporter, ProgressSender
from bragi_common.protocol import Capability, PartialSender, params_of
from bragi_common.s3 import ObjectStore
from bragi_common.telemetry import context_from_traceparent, setup_telemetry, shutdown_telemetry

JOBS_STREAM = "JOBS"
CANCEL_BUCKET = "cancel"
EVENTS_SUBJECT_PREFIX = "events.job."


class Worker:
    """Runs a set of capabilities against the ``JOBS`` stream."""

    def __init__(self, settings: Settings, capabilities: Sequence[Capability]) -> None:
        """Binds the worker to its settings and capability set."""
        self._settings = settings
        self._capabilities = list(capabilities)
        self._logger = logging.getLogger("bragi_common.worker")
        self._running = True
        self._tasks: list[asyncio.Task[None]] = []
        self._nc: NatsClient
        self._js: JetStreamContext
        self._kv: KeyValue
        self._pool: asyncpg.Pool
        self._cache: ResultCache
        self._store: ObjectStore
        self._tracer: Tracer

    async def run(self) -> None:
        """Connects, subscribes and consumes until stopped."""
        configure_logging()
        self._tracer = setup_telemetry(self._settings)
        self._nc = await nats.connect(self._settings.nats_url, name=self._settings.worker_name)
        self._js = self._nc.jetstream()
        self._kv = await self._js.key_value(CANCEL_BUCKET)
        self._pool = await asyncpg.create_pool(self._settings.database_url)
        self._store = ObjectStore(self._settings)
        self._cache = ResultCache(self._pool)
        Path(self._settings.scratch_dir).mkdir(parents=True, exist_ok=True)

        loop = asyncio.get_running_loop()
        for signal_number in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(signal_number, self._stop)

        self._logger.info(
            "worker started",
            extra={"capabilities": [cap.CAPABILITY for cap in self._capabilities]},
        )
        for capability in self._capabilities:
            interactive = await self._subscribe(capability, "interactive")
            background = await self._subscribe(capability, "background")
            self._tasks.append(
                asyncio.create_task(self._consume(capability, interactive, background))
            )

        try:
            await asyncio.gather(*self._tasks)
        finally:
            await self._close()

    def _stop(self) -> None:
        self._logger.info("shutdown requested")
        self._running = False
        asyncio.get_running_loop().call_later(self._settings.shutdown_grace_s, self._hard_stop)

    def _hard_stop(self) -> None:
        for task in self._tasks:
            task.cancel()

    async def _close(self) -> None:
        for task in self._tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        # `close`, not `drain`: a pull consumer has nothing to drain, and drain
        # would block SIGTERM shutdown for its whole timeout.
        await self._nc.close()
        await self._pool.close()
        shutdown_telemetry()

    async def _subscribe(
        self, capability: Capability, priority: str
    ) -> JetStreamContext.PullSubscription:
        name = f"{self._settings.worker_name}-{capability.CAPABILITY}-{priority}"
        durable = name.replace(".", "_")
        subject = f"jobs.{capability.CAPABILITY}.{priority}"
        return await self._js.pull_subscribe(subject, durable=durable, stream=JOBS_STREAM)

    async def _consume(
        self,
        capability: Capability,
        interactive: JetStreamContext.PullSubscription,
        background: JetStreamContext.PullSubscription,
    ) -> None:
        while self._running:
            messages = await self._fetch(interactive, 0.2)
            if not messages:
                messages = await self._fetch(background, 0.5)
            for message in messages:
                await self._handle(capability, message)

    async def _fetch(
        self, subscription: JetStreamContext.PullSubscription, timeout: float
    ) -> list[Msg]:
        try:
            return list(await subscription.fetch(1, timeout=timeout))
        except nats.errors.TimeoutError:
            return []

    async def _handle(self, capability: Capability, message: Msg) -> None:
        try:
            job = JobRequest.model_validate_json(message.data)
        except ValueError:
            self._logger.warning("dropping an unparseable job request")
            await message.term()
            return

        parent = context_from_traceparent(job.traceparent)
        with self._tracer.start_as_current_span(
            "jobs.consume",
            context=parent,
            kind=SpanKind.CONSUMER,
            attributes={
                "messaging.system": "nats",
                "bragi.job.id": job.jobId,
                "bragi.job.capability": job.capability,
            },
        ):
            heartbeat = asyncio.create_task(self._heartbeat(message))
            try:
                await self._execute(capability, job, message)
            finally:
                heartbeat.cancel()

    async def _execute(self, capability: Capability, job: JobRequest, message: Msg) -> None:
        cached = await self._cache.get(job.idempotencyKey)
        if cached is not None:
            self._logger.info("result cache hit", extra={"job": job.jobId})
            await self._publish(job, _event(job, JobEventType.completed, outputs=cached))
            await message.ack()
            return

        try:
            capability.ParamsModel.model_validate(params_of(job))
        except ValueError as error:
            await self._publish(
                job,
                _event(
                    job,
                    JobEventType.failed,
                    error=JobError(code="VALIDATION_FAILED", message=str(error), retryable=False),
                ),
            )
            await message.ack()
            return

        await self._publish(job, _event(job, JobEventType.started))
        scratch = Path(self._settings.scratch_dir) / job.jobId
        scratch.mkdir(parents=True, exist_ok=True)
        reporter = ProgressReporter(
            self._progress_sender(job), min_interval_s=self._settings.progress_interval_s
        )
        context = JobContext(
            job=job,
            store=self._store,
            reporter=reporter,
            cancel=CancelToken(self._kv, job.jobId),
            scratch=scratch,
            publish_partial=self._partial_sender(job),
        )

        try:
            outputs = await capability.run(job, context)
        except JobCancelledError:
            await self._publish(
                job,
                _event(
                    job,
                    JobEventType.failed,
                    error=JobError(code="JOB_CANCELLED", message="cancelled", retryable=False),
                ),
            )
            await message.ack()
        except Exception as error:  # the framework's job is to catch everything
            self._logger.exception("capability failed", extra={"job": job.jobId})
            await self._publish(
                job,
                _event(
                    job,
                    JobEventType.failed,
                    error=JobError(
                        code=_error_code(error), message=str(error), retryable=_retryable(error)
                    ),
                ),
            )
            if not _retryable(error):
                # A domain failure (e.g. a corrupt upload) will fail identically
                # on every attempt: settle it now instead of redelivering.
                await message.ack()
                return
            # The orchestrator is meant to own the retry count (05 §4.3); until
            # it does, cap it here from JetStream's own delivery counter so a
            # broken capability cannot loop forever.
            if _num_delivered(message) >= self._settings.max_attempts:
                await message.term()
            else:
                await message.nak()
        else:
            await self._cache.put(job.idempotencyKey, outputs)
            await self._publish(job, _event(job, JobEventType.completed, outputs=outputs))
            await message.ack()

    def _progress_sender(self, job: JobRequest) -> ProgressSender:
        """A throttled-safe sender that publishes ``progress`` for this job."""

        async def send(pct: float, eta_sec: float | None) -> None:
            await self._publish(job, _event(job, JobEventType.progress, pct=pct, etaSec=eta_sec))

        return send

    def _partial_sender(self, job: JobRequest) -> PartialSender:
        """A sender that publishes ``partial`` outputs for this job."""

        async def send(outputs: JobOutputs) -> None:
            await self._publish(job, _event(job, JobEventType.partial, outputs=outputs))

        return send

    async def _publish(self, job: JobRequest, event: JobEvent) -> None:
        subject = f"{EVENTS_SUBJECT_PREFIX}{job.jobId}"
        await self._js.publish(subject, event.model_dump_json(exclude_none=True).encode())

    async def _heartbeat(self, message: Msg, interval_s: float | None = None) -> None:
        interval = interval_s if interval_s is not None else self._settings.in_progress_interval_s
        try:
            while True:
                await asyncio.sleep(interval)
                await message.in_progress()
        except asyncio.CancelledError:
            return


def _event(
    job: JobRequest,
    event_type: JobEventType,
    *,
    pct: float | None = None,
    etaSec: float | None = None,  # noqa: N803 - the envelope's own field name
    outputs: JobOutputs | None = None,
    error: JobError | None = None,
) -> JobEvent:
    return JobEvent(
        schemaVersion=JobEventSchemaVersion.integer_1,
        jobId=job.jobId,
        type=event_type,
        pct=pct,
        etaSec=etaSec,
        outputs=outputs,
        error=error,
    )


def _error_code(error: Exception) -> str:
    code = getattr(error, "code", None)
    return code if isinstance(code, str) and code else "MODEL_ERROR"


def _retryable(error: Exception) -> bool:
    """Crashes are retryable; a :class:`JobFailure` carries its own decision."""
    return error.retryable if isinstance(error, JobFailure) else True


def _num_delivered(message: Msg) -> int:
    metadata = getattr(message, "metadata", None)
    delivered = getattr(metadata, "num_delivered", 1)
    return int(delivered) if isinstance(delivered, int) else 1


def run_worker(settings: Settings, capabilities: Sequence[Capability]) -> None:
    """Blocking entry point for a worker process."""
    asyncio.run(Worker(settings, capabilities).run())
