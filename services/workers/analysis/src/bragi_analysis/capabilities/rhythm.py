"""The ``rhythm`` capability (``specs/04`` §5.1).

Beats, downbeats, bpm (folded into 70..180), tempo curve, time signature,
confidence and tempo stability. Beat This! is the v1 tracker; without its pinned
weights the weight-free DSP tracker runs instead and the log says so.

Inputs: ``assets.source`` (the working asset; any decodable audio works).
Outputs: ``blobs.result`` (a ``RhythmResult``).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Literal

from pydantic import BaseModel, ConfigDict

from bragi_analysis import media, rhythm_post, trackers
from bragi_analysis.trackers.base import TRACKER_SAMPLE_RATE
from bragi_common.cancel import JobCancelledError
from bragi_common.context import JobContext
from bragi_common.generated.models import JobOutputs, JobRequest
from bragi_common.protocol import params_of

CAPABILITY = "analysis.rhythm"

MAX_DECODE_SEC = 31 * 60

_logger = logging.getLogger(__name__)


class ParamsModel(BaseModel):
    """Parameters for ``rhythm``."""

    model_config = ConfigDict(extra="forbid")

    #: ``auto`` uses Beat This! when its weights are installed, else the DSP fallback.
    tracker: Literal["auto", "beat_this", "dsp"] = "auto"


async def run(job: JobRequest, ctx: JobContext) -> JobOutputs:
    """Track the beats of the source audio."""
    params = ParamsModel.model_validate(params_of(job))
    tracker = trackers.select(params.tracker)
    if params.tracker == "auto" and tracker.name != "beat_this":
        _logger.warning("beat_this unavailable, using the DSP fallback", extra={"job": job.jobId})

    data = await ctx.download(job.inputs.assets["source"])
    await ctx.progress(0.1)
    source = ctx.scratch_path("source.bin")
    await asyncio.to_thread(source.write_bytes, data)
    del data

    info = await media.probe(source)
    pcm = await media.decode_pcm(
        source,
        sample_rate=TRACKER_SAMPLE_RATE,
        channels=1,
        max_seconds=MAX_DECODE_SEC,
        declared_duration_sec=info.duration_sec,
    )
    mono = pcm[:, 0]
    duration_sec = mono.shape[0] / TRACKER_SAMPLE_RATE
    await ctx.progress(0.3)
    if await ctx.cancelled():
        raise JobCancelledError(f"job {job.jobId} cancelled")

    estimate = await asyncio.to_thread(tracker.track, mono, TRACKER_SAMPLE_RATE)
    await ctx.progress(0.9)
    result = rhythm_post.build_result(estimate.beats, estimate.downbeats, duration_sec)

    blob = await ctx.upload_json(result.model_dump_json(exclude_none=True))
    await ctx.progress(1.0)
    return JobOutputs(blobs={"result": blob})
