"""The result cache: ``job_results`` keyed by ``idempotencyKey`` (``specs/05`` §4.3).

A hit publishes ``completed`` immediately, so an identical job is never
recomputed — the core defence of the GPU budget (05 §9).
"""

from __future__ import annotations

import json

import asyncpg

from bragi_common.generated.models import JobOutputs


class ResultCache:
    """Reads and writes the ``job_results`` table."""

    def __init__(self, pool: asyncpg.Pool) -> None:
        """Binds the cache to the Postgres pool."""
        self._pool = pool

    async def get(self, idempotency_key: str) -> JobOutputs | None:
        """The cached outputs, or ``None`` on a miss."""
        row = await self._pool.fetchrow(
            "SELECT outputs FROM job_results WHERE idempotency_key = $1",
            idempotency_key,
        )
        if row is None:
            return None
        raw = row["outputs"]
        payload = json.loads(raw) if isinstance(raw, str) else raw
        return JobOutputs.model_validate(payload)

    async def put(self, idempotency_key: str, outputs: JobOutputs) -> None:
        """Stores outputs, replacing any previous entry for the same key."""
        await self._pool.execute(
            """INSERT INTO job_results (idempotency_key, outputs) VALUES ($1, $2::jsonb)
               ON CONFLICT (idempotency_key) DO UPDATE SET outputs = EXCLUDED.outputs""",
            idempotency_key,
            outputs.model_dump_json(exclude_none=True),
        )
