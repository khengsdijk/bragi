"""The ``stem_activity`` capability (``specs/04`` §5.4).

Per stem: gated RMS (-45 dBFS, 250 ms hop) → ``active[] {startSec, endSec}`` and per-section
``presence`` (0..1). Entirely weight-free.

Inputs: the separated stems (``assets.stem_<role>``); before separation (or when the orchestrator
passes none, Q33) it falls back to ``assets.mix`` then ``assets.source`` as the ``other`` stem.
An optional ``blobs.structure`` supplies the sections every presence value is reported for; with
no sections ``presence`` is empty. Silent stems publish nothing active — never a failure
(04 §1.3, §10).
"""

from __future__ import annotations

import asyncio
import logging

import numpy as np
from pydantic import BaseModel, ConfigDict, Field

from bragi_analysis import activity, media
from bragi_analysis.activity import Section
from bragi_common.cancel import JobCancelledError
from bragi_common.context import JobContext
from bragi_common.generated.models import (
    JobOutputs,
    JobRequest,
    SecRange,
    SectionPresence,
    StemActivity,
    StemActivityResult,
    StemActivityResultSchemaVersion,
    StemRole,
    StructureResult,
)
from bragi_common.protocol import params_of

CAPABILITY = "analysis.stem_activity"

#: Gate RMS is rate-independent; a low mono rate keeps a 4-minute song cheap (04 §5.4).
STEM_RATE = 22_050
MAX_DECODE_SEC = 31 * 60

_LOGGER = logging.getLogger("bragi_analysis.stem_activity")


class ParamsModel(BaseModel):
    """Parameters for ``stem_activity``."""

    model_config = ConfigDict(extra="forbid")

    #: 04 §5.4: the gate, in dBFS.
    gateDb: float = Field(default=activity.GATE_DB, le=0.0)  # noqa: N815 - JSON field name
    #: 04 §5.4: the hop.
    hopSec: float = Field(default=activity.HOP_SEC, gt=0.0)  # noqa: N815


def _input_assets(job: JobRequest) -> dict[str, str]:
    """The ``role -> asset key`` map to read: stems, else mix, else source as ``other``."""
    assets = job.inputs.assets
    stems = {name.removeprefix("stem_"): name for name in assets if name.startswith("stem_")}
    if stems:
        return stems
    for fallback in ("mix", "source"):
        if fallback in assets:
            return {"other": fallback}
    raise ValueError("analysis.stem_activity needs assets.stem_<role>, assets.mix or assets.source")


async def _sections(job: JobRequest, ctx: JobContext) -> list[Section]:
    """Sections from an optional ``structure`` blob, else none."""
    blob = (job.inputs.blobs or {}).get("structure")
    if blob is None:
        return []
    result = StructureResult.model_validate_json(await ctx.download(blob))
    return [
        Section(index=index, start_sec=section.startSec, end_sec=section.endSec)
        for index, section in enumerate(result.sections)
    ]


async def _decode(job: JobRequest, ctx: JobContext, key: str, role: str) -> tuple[str, np.ndarray]:
    data = await ctx.download(job.inputs.assets[key])
    path = ctx.scratch_path(f"stem_{role}.bin")
    await asyncio.to_thread(path.write_bytes, data)
    info = await media.probe(path)
    pcm = await media.decode_pcm(
        path,
        sample_rate=STEM_RATE,
        channels=1,
        max_seconds=MAX_DECODE_SEC,
        declared_duration_sec=info.duration_sec,
    )
    return role, np.asarray(pcm[:, 0], dtype=np.float32)


async def run(job: JobRequest, ctx: JobContext) -> JobOutputs:
    """Gates every stem and publishes a ``StemActivityResult``."""
    params = ParamsModel.model_validate(params_of(job))
    roles = _input_assets(job)
    sections = await _sections(job, ctx)

    stems: dict[str, np.ndarray] = {}
    for index, (role, key) in enumerate(roles.items()):
        if await ctx.cancelled():
            raise JobCancelledError(f"job {job.jobId} cancelled")
        name, mono = await _decode(job, ctx, key, role)
        stems[name] = mono
        await ctx.progress(0.1 + 0.7 * (index + 1) / len(roles))

    analysed = await asyncio.to_thread(
        activity.analyse_stems,
        stems,
        STEM_RATE,
        sections,
        gate_db=params.gateDb,
        hop_sec=params.hopSec,
    )
    result = StemActivityResult(
        schemaVersion=StemActivityResultSchemaVersion.integer_1,
        stems=[
            StemActivity(
                role=StemRole(stem.role),
                active=[SecRange(startSec=start, endSec=end) for start, end in stem.active],
                presence=[
                    SectionPresence(index=index, presence=value) for index, value in stem.presence
                ],
            )
            for stem in analysed
        ],
    )
    _LOGGER.info(
        "stem_activity done",
        extra={
            "job": job.jobId,
            "stems": [stem.role for stem in analysed],
            "sections": len(sections),
        },
    )
    blob = await ctx.upload_json(result.model_dump_json(exclude_none=True))
    await ctx.progress(1.0)
    return JobOutputs(blobs={"stem_activity": blob})


__all__ = ["CAPABILITY", "MAX_DECODE_SEC", "STEM_RATE", "ParamsModel", "run"]
