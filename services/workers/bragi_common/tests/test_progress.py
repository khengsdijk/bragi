"""Progress throttling (05 §4.3: at most two reports per second)."""

from __future__ import annotations

import asyncio

from bragi_common.progress import ProgressReporter


def test_throttles_but_always_sends_the_final_report() -> None:
    sent: list[tuple[float, float | None]] = []

    async def send(pct: float, eta: float | None) -> None:
        sent.append((pct, eta))

    async def run() -> None:
        reporter = ProgressReporter(send, min_interval_s=100.0)
        await reporter.report(0.1)
        await reporter.report(0.2)  # too soon → dropped
        await reporter.report(0.2)  # unchanged → dropped
        await reporter.report(1.0)  # final is never dropped
        await reporter.report(1.0)  # unchanged → dropped

    asyncio.run(run())
    assert sent == [(0.1, None), (1.0, None)]


def test_clamps_out_of_range_values() -> None:
    sent: list[float] = []

    async def send(pct: float, eta: float | None) -> None:
        sent.append(pct)

    async def run() -> None:
        reporter = ProgressReporter(send, min_interval_s=0.0)
        await reporter.report(-1.0)
        await reporter.report(2.0)

    asyncio.run(run())
    assert sent == [0.0, 1.0]
