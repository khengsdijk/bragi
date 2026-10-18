"""Cancellation through the NATS ``cancel.<jobId>`` KV bucket (``specs/05`` §4.4).

``DELETE /jobs/{id}`` writes the flag; a capability checks
:meth:`CancelToken.cancelled` between chunks and raises :class:`JobCancelledError`
when it is set.
"""

from __future__ import annotations

from nats.js import errors as js_errors
from nats.js.kv import KeyValue


class JobCancelledError(Exception):
    """Raised by a capability that observed the cancel flag."""


class CancelToken:
    """Polls the cancel flag for one job."""

    def __init__(self, kv: KeyValue, job_id: str) -> None:
        """Binds the token to the ``cancel`` KV bucket and one job id."""
        self._kv = kv
        self._key = f"cancel.{job_id}"

    async def cancelled(self) -> bool:
        """True when the job has been cancelled."""
        try:
            await self._kv.get(self._key)
        except js_errors.KeyNotFoundError:
            return False
        return True
