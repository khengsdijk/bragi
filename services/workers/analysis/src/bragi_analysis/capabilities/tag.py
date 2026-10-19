"""The ``tag`` capability (``specs/04`` §6.2).

Scores the controlled taxonomy for a song: trained MLP heads when they are present, zero-shot
cosine over the taxonomy prompts otherwise (which is also the only path for descriptors and era).
The song embedding comes from ``blobs.embed_full`` when the orchestrator passes it, so ``tag``
does not re-embed audio it has already seen; otherwise it is computed here with the same
``Embedder`` selection.

Input ``assets.source`` (+ optional ``blobs.embed_full``); output ``blobs.tag`` (a ``TagResult``).
"""

from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path
from typing import Literal

import numpy as np
from pydantic import BaseModel, ConfigDict, Field

from bragi_analysis.embedding import capability as base
from bragi_analysis.embedding import pipeline
from bragi_analysis.tagging import pipeline as tagging_pipeline
from bragi_analysis.tagging import taxonomy as taxonomy_module
from bragi_analysis.tagging import zeroshot
from bragi_common.cancel import JobCancelledError
from bragi_common.context import JobContext
from bragi_common.generated.models import EmbeddingResult, JobOutputs, JobRequest
from bragi_common.protocol import params_of

CAPABILITY = "analysis.tag"

_LOGGER = logging.getLogger("bragi_analysis.tag")


class ParamsModel(BaseModel):
    """Parameters for ``tag``."""

    model_config = ConfigDict(extra="forbid")

    #: ``auto`` picks CLAP when a verified checkpoint is configured, else the fallback.
    embedder: Literal["auto", "clap", "fallback"] = "auto"
    #: ``auto`` uses trained heads when ``BRAGI_TAG_HEADS`` holds them, else zero-shot.
    classifier: Literal["auto", "zeroshot", "heads"] = "auto"
    #: Overrides ``BRAGI_TAG_HEADS`` (a directory of ``<category>.npz`` heads).
    headsDir: str | None = Field(default=None)  # noqa: N815 - JSON field name


def _heads_dir(params: ParamsModel) -> Path | None:
    configured = params.headsDir or os.environ.get("BRAGI_TAG_HEADS")
    return Path(configured) if configured else None


async def run(job: JobRequest, ctx: JobContext) -> JobOutputs:
    """Labels the source and publishes a ``TagResult``."""
    params = ParamsModel.model_validate(params_of(job))

    heads: dict[taxonomy_module.Category, zeroshot.Head] = {}
    if params.classifier != "zeroshot":
        heads = zeroshot.load_heads(_heads_dir(params))
    if params.classifier == "heads" and not heads:
        raise ValueError("classifier 'heads' was requested but no trained heads were found")

    embedder = base.embedder_for(params.embedder)
    blob = (job.inputs.blobs or {}).get("embed_full")
    if blob is not None:
        embedding = EmbeddingResult.model_validate_json(await ctx.download(blob))
        if embedding.scope.value != "song" or not embedding.vectors:
            raise ValueError("blobs.embed_full must be a song-scope EmbeddingResult with a vector")
        audio_vector = np.asarray(embedding.vectors[0].vector, dtype=np.float64)
        degraded = bool(embedding.lowConfidence)
    else:
        mono, _ = await base.decode_mono(job, ctx, "source")
        if await ctx.cancelled():
            raise JobCancelledError(f"job {job.jobId} cancelled")
        audio_vector, degraded = await asyncio.to_thread(
            pipeline.pooled_vector, embedder, mono, base.DECODE_RATE, None
        )
    await ctx.progress(0.6)

    result = await asyncio.to_thread(
        tagging_pipeline.build_result,
        audio_vector,
        taxonomy_module.default(),
        embedder,
        heads,
        None,
        degraded=degraded,
    )
    _LOGGER.info(
        "tag done",
        extra={
            "job": job.jobId,
            "model": embedder.model,
            "heads": sorted(heads),
            "lowConfidence": bool(result.lowConfidence),
        },
    )
    blob_hash = await ctx.upload_json(result.model_dump_json(exclude_none=True))
    await ctx.progress(1.0)
    return JobOutputs(blobs={CAPABILITY.removeprefix("analysis."): blob_hash})


__all__ = ["CAPABILITY", "ParamsModel", "run"]
