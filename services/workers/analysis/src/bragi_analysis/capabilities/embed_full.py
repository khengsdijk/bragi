"""The ``embed_full`` capability (``specs/04`` §6.1): one song-level embedding.

Input ``assets.source``; output ``blobs.embed_full`` (an ``EmbeddingResult`` with ``scope:
"song"``). The vector is not a unique output of any asset, so it is not stored as one; when
``storeEmbeddings`` is set the vectors are written to Postgres/pgvector (05 §5).
"""

from __future__ import annotations

import asyncio
import logging

from bragi_analysis.embedding import capability as base
from bragi_analysis.embedding import pipeline
from bragi_analysis.embedding.capability import DECODE_RATE, EmbedParams
from bragi_common.cancel import JobCancelledError
from bragi_common.context import JobContext
from bragi_common.generated.models import JobOutputs, JobRequest
from bragi_common.protocol import params_of

CAPABILITY = "analysis.embed_full"

ParamsModel = EmbedParams

_LOGGER = logging.getLogger("bragi_analysis.embed_full")


async def run(job: JobRequest, ctx: JobContext) -> JobOutputs:
    """Embeds the whole source and publishes an ``EmbeddingResult``."""
    params = EmbedParams.model_validate(params_of(job))
    source = job.inputs.assets["source"]

    mono, duration = await base.decode_mono(job, ctx, "source")
    if await ctx.cancelled():
        raise JobCancelledError(f"job {job.jobId} cancelled")
    embedder = base.embedder_for(params.embedder)
    result = await asyncio.to_thread(pipeline.song_result, embedder, mono, DECODE_RATE)
    await ctx.progress(0.8)
    await base.persist(params, source, result, job.jobId)
    _LOGGER.info(
        "embed_full done",
        extra={
            "job": job.jobId,
            "model": result.model,
            "durationSec": round(duration, 2),
            "lowConfidence": bool(result.lowConfidence),
        },
    )
    blob = await ctx.upload_json(result.model_dump_json(exclude_none=True))
    await ctx.progress(1.0)
    return JobOutputs(blobs={CAPABILITY.removeprefix("analysis."): blob})


__all__ = ["CAPABILITY", "ParamsModel", "run"]
