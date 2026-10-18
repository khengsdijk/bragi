"""Progress reporting, rate-limited to two events per second (``specs/05`` §4.3)."""

from __future__ import annotations

import time
from collections.abc import Awaitable, Callable

ProgressSender = Callable[[float, "float | None"], Awaitable[None]]


class ProgressReporter:
    """Throttles ``progress`` events so a busy capability cannot flood NATS."""

    def __init__(self, send: ProgressSender, min_interval_s: float = 0.5) -> None:
        """Wraps ``send`` with a ``min_interval_s`` throttle."""
        self._send = send
        self._min_interval = min_interval_s
        self._last = 0.0
        self._last_pct = -1.0

    async def report(self, pct: float, eta_sec: float | None = None) -> None:
        """Sends ``pct`` (0..1) unless it is too soon and not a final report."""
        clamped = min(max(pct, 0.0), 1.0)
        now = time.monotonic()
        if clamped < 1.0 and now - self._last < self._min_interval:
            return
        if clamped == self._last_pct:
            return
        self._last = now
        self._last_pct = clamped
        await self._send(clamped, eta_sec)
