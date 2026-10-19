"""Shared machinery for the three ``embed_*`` capabilities (``specs/04`` §6.1)."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Sequence
from typing import Literal

import numpy as np
from numpy.typing import NDArray
from pydantic import BaseModel, ConfigDict
from pydantic import Field as PydanticField

from bragi_analysis import media
from bragi_analysis.embedding import store as embedding_store
from bragi_analysis.embedding.protocol import Embedder, select
from bragi_common.context import JobContext
from bragi_common.generated.models import EmbeddingResult, JobRequest

#: Decode rate for embeddings; CLAP works at 48 kHz and the working asset already is (04 §3.1).
DECODE_RATE = 48_000
MAX_DECODE_SEC = 31 * 60

_LOGGER = logging.getLogger("bragi_analysis.embedding")


class EmbedParams(BaseModel):
    """Parameters shared by ``embed_full``, ``section_embed`` and ``stem_embed``."""

    model_config = ConfigDict(extra="forbid")

    #: ``auto`` picks CLAP when a verified checkpoint is configured, else the fallback.
    embedder: Literal["auto", "clap", "fallback"] = "auto"
    #: Persist the vectors to Postgres/pgvector (05 §5); off by default so the CPU gate needs no DB.
    storeEmbeddings: bool = PydanticField(default=False)  # noqa: N815 - JSON field name


def embedder_for(kind: str) -> Embedder:
    """Selects and logs the embedder for a capability's ``embedder`` param."""
    embedder = select(kind)
    _LOGGER.info("embedding with %s", embedder.model)
    return embedder


async def decode_mono(
    job: JobRequest, ctx: JobContext, asset_key: str, rate: int = DECODE_RATE
) -> tuple[NDArray[np.float32], float]:
    """Downloads and decodes one asset to mono float32 at ``rate``."""
    data = await ctx.download(job.inputs.assets[asset_key])
    path = ctx.scratch_path(f"{asset_key}.bin")
    await asyncio.to_thread(path.write_bytes, data)
    info = await media.probe(path)
    pcm = await media.decode_pcm(
        path,
        sample_rate=rate,
        channels=1,
        max_seconds=MAX_DECODE_SEC,
        declared_duration_sec=info.duration_sec,
    )
    mono = np.asarray(pcm[:, 0], dtype=np.float32)
    return mono, mono.shape[0] / rate


async def persist(
    params: EmbedParams, asset_hash: str, result: EmbeddingResult, job_id: str
) -> None:
    """Writes the vectors when ``storeEmbeddings`` is set (05 §5); never touches a DB otherwise."""
    if not params.storeEmbeddings:
        return
    await persist_rows(params, embedding_store.rows_from_result(asset_hash, result), job_id)


async def persist_rows(
    params: EmbedParams, rows: Sequence[embedding_store.EmbeddingRow], job_id: str
) -> None:
    """Writes ready-made rows when ``storeEmbeddings`` is set (05 §5)."""
    if not params.storeEmbeddings or not rows:
        return
    connection = await embedding_store.open_store()
    try:
        written = await connection.upsert(rows)
    finally:
        await connection.close()
    _LOGGER.info("stored embeddings", extra={"job": job_id, "rows": written})


async def upload(ctx: JobContext, key: str, result: EmbeddingResult) -> dict[str, str]:
    """Uploads an ``EmbeddingResult`` as the ``key`` blob."""
    blob = await ctx.upload_json(result.model_dump_json(exclude_none=True))
    return {key: blob}


__all__ = [
    "DECODE_RATE",
    "MAX_DECODE_SEC",
    "EmbedParams",
    "decode_mono",
    "embedder_for",
    "persist",
    "upload",
]
