"""The cancel flag (05 §4.4)."""

from __future__ import annotations

import asyncio
from typing import cast

from nats.js.errors import KeyNotFoundError
from nats.js.kv import KeyValue

from bragi_common.cancel import CancelToken


class FakeKv:
    def __init__(self, present: bool) -> None:
        self._present = present

    async def get(self, key: str) -> object:
        if self._present:
            return {"key": key}
        raise KeyNotFoundError()


def test_not_cancelled_when_the_key_is_absent() -> None:
    token = CancelToken(cast(KeyValue, FakeKv(present=False)), "job_01")
    assert asyncio.run(token.cancelled()) is False


def test_cancelled_when_the_key_exists() -> None:
    token = CancelToken(cast(KeyValue, FakeKv(present=True)), "job_01")
    assert asyncio.run(token.cancelled()) is True
