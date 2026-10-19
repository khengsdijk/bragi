"""The ``stem_embed`` capability (``specs/04`` §6.1): one embedding per stem.

Inputs ``assets.stem_<role>`` and an optional ``blobs.stem_activity``; output
``blobs.stem_embed`` (an ``EmbeddingResult`` with ``scope: "stem"`` and one vector per stem,
``scopeRef`` = the role). Each stem is pooled over its **active regions** when a ``stem_activity``
blob is passed (04 §6.1), and over the whole stem otherwise. Without any stem asset the result
carries no vectors and is flagged ``lowConfidence`` rather than failing.
"""

from __future__ import annotations

import asyncio
import logging

import numpy as np

from bragi_analysis.embedding import capability as base
from bragi_analysis.embedding import pipeline, store
from bragi_common.cancel import JobCancelledError
from bragi_common.context import JobContext
from bragi_common.generated.models import (
    JobOutputs,
    JobRequest,
    StemActivityResult,
)
from bragi_common.protocol import params_of

CAPABILITY = "analysis.stem_embed"

ParamsModel = base.EmbedParams

_LOGGER = logging.getLogger("bragi_analysis.stem_embed")


async def _active(job: JobRequest, ctx: JobContext) -> dict[str, list[tuple[float, float]]]:
    """Active spans per stem role from an optional ``stem_activity`` blob."""
    blob = (job.inputs.blobs or {}).get("stem_activity")
    if blob is None:
        return {}
    result = StemActivityResult.model_validate_json(await ctx.download(blob))
    return {
        stem.role.value: [(region.startSec, region.endSec) for region in stem.active]
        for stem in result.stems
    }


async def run(job: JobRequest, ctx: JobContext) -> JobOutputs:
    """Embeds every stem and publishes an ``EmbeddingResult``."""
    params = base.EmbedParams.model_validate(params_of(job))
    jobs = {
        name: name.removeprefix("stem_") for name in job.inputs.assets if name.startswith("stem_")
    }
    by_role = {role: name for name, role in jobs.items()}
    active = await _active(job, ctx)
    embedder = base.embedder_for(params.embedder)

    stems: dict[str, tuple[np.ndarray, int, list[tuple[float, float]] | None]] = {}
    for index, (name, role) in enumerate(jobs.items()):
        if await ctx.cancelled():
            raise JobCancelledError(f"job {job.jobId} cancelled")
        mono, _ = await base.decode_mono(job, ctx, name)
        stems[role] = (mono, base.DECODE_RATE, active.get(role))
        del mono
        await ctx.progress(0.1 + 0.7 * (index + 1) / len(jobs))

    result = await asyncio.to_thread(pipeline.stem_result, embedder, stems)
    rows = [
        store.row_for(
            job.inputs.assets[by_role[entry.scopeRef]],
            "stem",
            entry.scopeRef,
            result.model,
            entry.vector,
        )
        for entry in result.vectors
        if entry.scopeRef is not None and entry.scopeRef in by_role
    ]
    await base.persist_rows(params, rows, job.jobId)
    _LOGGER.info(
        "stem_embed done",
        extra={"job": job.jobId, "model": result.model, "stems": len(result.vectors)},
    )
    blob = await ctx.upload_json(result.model_dump_json(exclude_none=True))
    await ctx.progress(1.0)
    return JobOutputs(blobs={CAPABILITY.removeprefix("analysis."): blob})


__all__ = ["CAPABILITY", "ParamsModel", "run"]
