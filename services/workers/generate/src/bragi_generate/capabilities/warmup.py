"""The ``generate.warmup`` capability (``specs/09-generation.md`` §5).

A cheap ping that loads the model the first interactive extend will use, so the user
does not pay the cold start. The API dedupes pings while one is in flight or the
model is warm, so this runs at most once per warm-up window.

The fake backend's model is external (there is nothing to load), so its warm-up is a
no-op and the ping still goes through the whole job path.

No `JobMetrics`: model loading is not generation time, and a cold load inside the
first real generation is already part of that job's backend timing.
"""

from __future__ import annotations

import asyncio
import logging

from bragi_common.context import JobContext
from bragi_common.generated.models import GenerateWarmupParams, JobOutputs, JobRequest
from bragi_common.protocol import params_of
from bragi_generate import routing

#: Capability name; the NATS subject is ``jobs.generate.warmup.<priority>`` (05 §4.1).
CAPABILITY = "generate.warmup"
#: The model that warm-up loads is the one the first interactive extend uses (09 §5).
WARMUP_ROUTE = "generate.extend"
WARMUP_TIER = "preview"
_LOGGER = logging.getLogger("bragi_generate.warmup")


async def run(job: JobRequest, ctx: JobContext) -> JobOutputs:
    """Loads the routed backend's model and returns no outputs."""
    GenerateWarmupParams.model_validate(params_of(job))
    backend = routing.backend_for(WARMUP_ROUTE, WARMUP_TIER)
    await asyncio.to_thread(backend.warmup)
    await ctx.progress(1.0)
    _LOGGER.info("warm-up done", extra={"job": job.jobId, "backend": backend.name})
    return JobOutputs()


#: The capability contract's names (13 §3).
ParamsModel = GenerateWarmupParams


__all__ = ["CAPABILITY", "WARMUP_ROUTE", "WARMUP_TIER", "ParamsModel", "run"]
