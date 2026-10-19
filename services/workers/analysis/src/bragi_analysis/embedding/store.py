"""Writing embedding vectors to Postgres/pgvector (``specs/05`` §5, WP-1.6).

Embeddings are keyed by **asset**, not user, so identical audio is embedded once (05 §5). The
``embeddings`` table already exists; migration ``002_embeddings_hnsw`` adds the HNSW index the
writer wants. The path is exercised with a fake pool: the CPU gate never touches Postgres, and
persistence only happens when a capability is asked to (``storeEmbeddings``).
"""

from __future__ import annotations

import hashlib
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol

from bragi_common.generated.models import EmbeddingResult


#: One row of the ``embeddings`` table.
@dataclass(frozen=True)
class EmbeddingRow:
    """A single embedding vector ready to insert."""

    id: str
    asset_hash: str
    scope: str
    scope_ref: str | None
    model: str
    vector: list[float]


INSERT_SQL = (
    "INSERT INTO embeddings (id, asset_hash, scope, scope_ref, model, vec) "
    "VALUES ($1, $2, $3, $4, $5, $6::vector) "
    "ON CONFLICT (id) DO UPDATE SET vec = EXCLUDED.vec"
)


def _vector_literal(vector: Sequence[float]) -> str:
    """Pgvector's text input format, e.g. ``[0.1,-0.2,...]``."""
    return "[" + ",".join(f"{value:.8g}" for value in vector) + "]"


def row_id(asset_hash: str, scope: str, scope_ref: str | None, model: str) -> str:
    """A deterministic row id for ``(asset, scope, ref, model)``."""
    key = f"{asset_hash}:{scope}:{scope_ref or '-'}:{model}"
    return "emb_" + hashlib.sha256(key.encode("utf-8")).hexdigest()[:32]


def rows_from_result(asset_hash: str, result: EmbeddingResult) -> list[EmbeddingRow]:
    """The rows an :class:`EmbeddingResult` inserts (one per vector)."""
    return [
        row_for(asset_hash, result.scope.value, entry.scopeRef, result.model, entry.vector)
        for entry in result.vectors
    ]


def row_for(
    asset_hash: str,
    scope: str,
    scope_ref: str | None,
    model: str,
    vector: Sequence[float],
) -> EmbeddingRow:
    """One row for one vector."""
    return EmbeddingRow(
        id=row_id(asset_hash, scope, scope_ref, model),
        asset_hash=asset_hash,
        scope=scope,
        scope_ref=scope_ref,
        model=model,
        vector=[float(value) for value in vector],
    )


class EmbeddingStore(Protocol):
    """The store surface the capabilities use."""

    async def upsert(self, rows: Sequence[EmbeddingRow]) -> int:
        """Inserts or replaces ``rows``, returning how many were written."""
        ...

    async def close(self) -> None:
        """Releases the connection."""
        ...


class PgVectorStore:
    """An :class:`EmbeddingStore` over an ``asyncpg`` pool (or any compatible fake)."""

    def __init__(self, pool: object) -> None:
        """Binds the store to a pool exposing ``executemany`` and ``close``."""
        self._pool = pool

    async def upsert(self, rows: Sequence[EmbeddingRow]) -> int:
        """Writes every row through one ``executemany`` (``$6::vector`` from a text literal)."""
        if not rows:
            return 0
        params = [
            (
                row.id,
                row.asset_hash,
                row.scope,
                row.scope_ref,
                row.model,
                _vector_literal(row.vector),
            )
            for row in rows
        ]
        await self._pool.executemany(INSERT_SQL, params)  # type: ignore[attr-defined]
        return len(rows)

    async def close(self) -> None:
        """Closes the pool this store owns."""
        await self._pool.close()  # type: ignore[attr-defined]


async def open_store(dsn: str | None = None) -> EmbeddingStore:
    """Opens a short-lived single-connection pool from ``dsn`` (defaults to the settings)."""
    import asyncpg

    from bragi_common.config import Settings

    pool = await asyncpg.create_pool(dsn or Settings().database_url, min_size=1, max_size=1)
    return PgVectorStore(pool)


__all__ = [
    "INSERT_SQL",
    "EmbeddingRow",
    "EmbeddingStore",
    "PgVectorStore",
    "open_store",
    "row_for",
    "row_id",
    "rows_from_result",
]
