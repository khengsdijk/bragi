"""The result cache (05 §4.3 step 2, §9)."""

from __future__ import annotations

import asyncio
import json
from typing import cast

import asyncpg

from bragi_common.cache import ResultCache
from bragi_common.generated.models import JobOutputs

HASH_A = "sha256:" + "a" * 64
HASH_B = "sha256:" + "b" * 64
HASH_C = "sha256:" + "c" * 64


class FakePool:
    def __init__(self, row: object | None = None) -> None:
        self._row = row
        self.executed: list[tuple[object, ...]] = []

    async def fetchrow(self, query: str, *args: object) -> object | None:
        return self._row

    async def execute(self, query: str, *args: object) -> str:
        self.executed.append(args)
        return "INSERT 0 1"


def test_miss_returns_none() -> None:
    cache = ResultCache(cast(asyncpg.Pool, FakePool()))
    assert asyncio.run(cache.get("key")) is None


def test_hit_parses_jsonb_strings_into_outputs() -> None:
    row = {"outputs": json.dumps({"blobs": {"manifest": HASH_A}})}
    cache = ResultCache(cast(asyncpg.Pool, FakePool(row)))
    outputs = asyncio.run(cache.get("key"))
    assert outputs is not None
    assert outputs.blobs == {"manifest": HASH_A}


def test_hit_accepts_an_already_decoded_jsonb() -> None:
    row = {"outputs": {"blobs": {"manifest": HASH_B}}}
    cache = ResultCache(cast(asyncpg.Pool, FakePool(row)))
    outputs = asyncio.run(cache.get("key"))
    assert outputs is not None
    assert outputs.blobs == {"manifest": HASH_B}


def test_put_upserts_serialised_outputs() -> None:
    pool = FakePool()
    cache = ResultCache(cast(asyncpg.Pool, pool))
    asyncio.run(cache.put("key", JobOutputs(assets={"source": HASH_C})))
    assert len(pool.executed) == 1
    key, payload = pool.executed[0]
    assert key == "key"
    assert HASH_C in str(payload)
