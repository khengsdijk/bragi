"""The ``structure`` capability (``specs/04`` §5.2).

Section boundaries, functional labels and repeat groups. The v1 method is weight-free
(self-similarity + novelty + repetition grouping, ADR-0010), so it needs no model files.

Inputs: ``assets.source`` (any decodable audio) and, optionally, ``blobs.rhythm`` (the
``rhythm`` stage's ``RhythmResult``). The DAG runs ``structure`` after ``rhythm``; when the
blob is not passed (the orchestrator does not wire blobs yet, Q33) the beats are tracked here
with the same tracker selection ``rhythm`` uses, so the result is the same either way.
Outputs: ``blobs.result`` (a ``StructureResult``).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Literal

import numpy as np
from pydantic import BaseModel, ConfigDict

from bragi_analysis import media, trackers
from bragi_analysis.structure import pipeline
from bragi_analysis.trackers.base import TRACKER_SAMPLE_RATE
from bragi_common.cancel import JobCancelledError
from bragi_common.context import JobContext
from bragi_common.generated.models import JobOutputs, JobRequest, RhythmResult
from bragi_common.protocol import params_of

CAPABILITY = "analysis.structure"

MAX_DECODE_SEC = 31 * 60

_logger = logging.getLogger(__name__)


class ParamsModel(BaseModel):
    """Parameters for ``structure``."""

    model_config = ConfigDict(extra="forbid")

    #: Beat tracker used when no ``blobs.rhythm`` is passed (same choices as ``rhythm``).
    tracker: Literal["auto", "beat_this", "dsp"] = "auto"


async def run(job: JobRequest, ctx: JobContext) -> JobOutputs:
    """Segments the source audio."""
    params = ParamsModel.model_validate(params_of(job))

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
    await ctx.progress(0.3)
    if await ctx.cancelled():
        raise JobCancelledError(f"job {job.jobId} cancelled")

    rhythm_hash = (job.inputs.blobs or {}).get("rhythm")
    if rhythm_hash is not None:
        rhythm = RhythmResult.model_validate_json(await ctx.download(rhythm_hash))
        analysis = await asyncio.to_thread(
            pipeline.analyse,
            mono,
            TRACKER_SAMPLE_RATE,
            np.asarray(rhythm.beats, dtype=np.float64),
            np.asarray(rhythm.downbeats, dtype=np.float64),
            beat_confidence=rhythm.confidence,
        )
    else:
        tracker = trackers.select(params.tracker)
        _logger.info(
            "no rhythm blob, tracking beats with %s", tracker.name, extra={"job": job.jobId}
        )
        analysis = await asyncio.to_thread(
            pipeline.analyse_with_tracker, mono, TRACKER_SAMPLE_RATE, tracker
        )
    await ctx.progress(0.9)

    blob = await ctx.upload_json(analysis.result.model_dump_json(exclude_none=True))
    await ctx.progress(1.0)
    return JobOutputs(blobs={"result": blob})
