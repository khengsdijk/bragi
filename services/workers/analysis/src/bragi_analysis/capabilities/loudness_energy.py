"""The ``loudness_energy`` capability (``specs/04`` §5.5).

EBU R128 loudness (integrated LUFS, LRA, true peak, short-term series) and the
energy curve that feeds the skyline, both at a hop of 0.5 s.

Inputs: ``assets.source`` (the working asset; any decodable audio works).
Outputs: ``blobs.result`` (a ``LoudnessEnergyResult``). Per-section aggregates and
``absoluteEnergy`` are omitted: they need ``structure`` and library-wide
constants, which do not exist yet (04 §5.5).
"""

from __future__ import annotations

import asyncio

from pydantic import BaseModel, ConfigDict

from bragi_analysis import media
from bragi_analysis.dsp import energy, loudness
from bragi_common.cancel import JobCancelledError
from bragi_common.context import JobContext
from bragi_common.generated.models import (
    JobOutputs,
    JobRequest,
    LoudnessEnergyResult,
    LoudnessEnergyResultSchemaVersion,
)
from bragi_common.protocol import params_of

CAPABILITY = "analysis.loudness_energy"

#: Same ceiling as ingest (04 §3.1); the working asset is already inside it.
MAX_DECODE_SEC = 31 * 60


class ParamsModel(BaseModel):
    """``loudness_energy`` has no tunable parameters (the weights live in ``energy.toml``)."""

    model_config = ConfigDict(extra="forbid")


async def run(job: JobRequest, ctx: JobContext) -> JobOutputs:
    """Measure loudness and derive the energy curve."""
    ParamsModel.model_validate(params_of(job))
    data = await ctx.download(job.inputs.assets["source"])
    await ctx.progress(0.1)

    source = ctx.scratch_path("source.bin")
    await asyncio.to_thread(source.write_bytes, data)
    del data
    info = await media.probe(source)
    pcm = await media.decode_pcm(
        source,
        sample_rate=loudness.SAMPLE_RATE,
        channels=2,
        max_seconds=MAX_DECODE_SEC,
        declared_duration_sec=info.duration_sec,
        source_channels=info.channels,
    )
    await ctx.progress(0.4)
    if await ctx.cancelled():
        raise JobCancelledError(f"job {job.jobId} cancelled")

    measured = await asyncio.to_thread(loudness.measure, pcm, energy.HOP_SEC)
    await ctx.progress(0.7)
    curve = await asyncio.to_thread(energy.energy_curve, pcm.mean(axis=1), measured.short_term_lufs)

    result = LoudnessEnergyResult(
        schemaVersion=LoudnessEnergyResultSchemaVersion.integer_1,
        hopSec=energy.HOP_SEC,
        lufsIntegrated=round(measured.integrated_lufs, 2),
        lra=round(measured.lra, 2),
        truePeakDb=round(measured.true_peak_db, 2),
        shortTermLufs=[round(float(v), 2) for v in measured.short_term_lufs],
        energy=[round(float(v), 4) for v in curve],
    )
    blob = await ctx.upload_json(result.model_dump_json(exclude_none=True))
    await ctx.progress(1.0)
    return JobOutputs(blobs={"result": blob})
