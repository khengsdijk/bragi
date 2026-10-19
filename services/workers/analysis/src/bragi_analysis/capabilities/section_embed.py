"""The ``section_embed`` capability (``specs/04`` §6.1): one embedding per section.

Input ``assets.source`` and an optional ``blobs.structure``; output ``blobs.section_embed`` (an
``EmbeddingResult`` with ``scope: "section"`` and one vector per section, ``scopeRef`` = the
section index — the structure blob has no section ids). With no structure blob the result carries
no vectors and is flagged ``lowConfidence`` rather than failing.
"""

from __future__ import annotations

import asyncio
import logging

from bragi_analysis.embedding import capability as base
from bragi_analysis.embedding import pipeline
from bragi_analysis.embedding.capability import DECODE_RATE, EmbedParams
from bragi_analysis.embedding.pipeline import Span
from bragi_common.cancel import JobCancelledError
from bragi_common.context import JobContext
from bragi_common.generated.models import JobOutputs, JobRequest, StructureResult
from bragi_common.protocol import params_of

CAPABILITY = "analysis.section_embed"

ParamsModel = EmbedParams

_LOGGER = logging.getLogger("bragi_analysis.section_embed")


async def _sections(job: JobRequest, ctx: JobContext) -> list[Span]:
    """Section spans from the structure blob (empty when there is none)."""
    blob = (job.inputs.blobs or {}).get("structure")
    if blob is None:
        return []
    result = StructureResult.model_validate_json(await ctx.download(blob))
    return [
        Span(ref=str(index), start_sec=section.startSec, end_sec=section.endSec)
        for index, section in enumerate(result.sections)
    ]


async def run(job: JobRequest, ctx: JobContext) -> JobOutputs:
    """Embeds every structure section and publishes an ``EmbeddingResult``."""
    params = EmbedParams.model_validate(params_of(job))

    mono, _ = await base.decode_mono(job, ctx, "source")
    if await ctx.cancelled():
        raise JobCancelledError(f"job {job.jobId} cancelled")
    sections = await _sections(job, ctx)
    embedder = base.embedder_for(params.embedder)
    result = await asyncio.to_thread(pipeline.section_result, embedder, mono, DECODE_RATE, sections)
    await ctx.progress(0.8)
    await base.persist(params, job.inputs.assets["source"], result, job.jobId)
    _LOGGER.info(
        "section_embed done",
        extra={"job": job.jobId, "model": result.model, "sections": len(result.vectors)},
    )
    blob = await ctx.upload_json(result.model_dump_json(exclude_none=True))
    await ctx.progress(1.0)
    return JobOutputs(blobs={CAPABILITY.removeprefix("analysis."): blob})


__all__ = ["CAPABILITY", "ParamsModel", "run"]
