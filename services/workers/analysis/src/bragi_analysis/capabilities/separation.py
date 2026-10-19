"""The ``analysis.separation`` capability (``specs/04`` §4, WP-1.3).

Input ``assets.mix``: the 48 kHz 24-bit FLAC working asset. Output: one 24-bit FLAC per
stem (``assets.stem_<role>``) plus ``assets.residual`` and the ``blobs.separation``
:class:`SeparationResult`. Stems whose whole-song RMS is below the floor are dropped.

``mix - Σ stems - residual`` is zero up to FLAC quantisation (about -138 dBFS) because the
residual is computed from the stems *as stored* (see :class:`ResidualAccumulator`).
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
from collections.abc import Callable
from typing import Literal

import numpy as np
from pydantic import BaseModel, ConfigDict, Field

from bragi_analysis.separation import pipeline as pl
from bragi_analysis.separation.audio import decode_flac, encode_flac
from bragi_analysis.separation.weights import pin_for
from bragi_common.cancel import JobCancelledError
from bragi_common.context import JobContext
from bragi_common.generated.models import (
    JobOutputs,
    JobRequest,
    SeparationResult,
    SeparationResultSchemaVersion,
    StemAsset,
    StemRole,
)
from bragi_common.protocol import params_of

#: Capability name; the NATS subject is ``jobs.analysis.separation.<priority>`` (05 §4.1).
CAPABILITY = "analysis.separation"

_LOGGER = logging.getLogger("bragi_analysis.separation")


class ParamsModel(BaseModel):
    """Parameters for ``analysis.separation``."""

    model_config = ConfigDict(extra="forbid")

    #: Pinned model name (``models_lock.json``); HTDemucs 6-source is the v1 default (04 §4).
    model: Literal["htdemucs_6s", "htdemucs"] = "htdemucs_6s"
    #: ``auto`` picks cuda, then mps, then cpu.
    device: Literal["auto", "cpu", "mps", "cuda"] = "auto"
    #: Upper bound for a chunk; clamped to what the model accepts (HTDemucs: 7.8 s).
    segmentSec: float = Field(default=10.0, gt=1.0)  # noqa: N815 - JSON field name
    #: Overlap between consecutive chunks, cross-faded linearly.
    overlapSec: float = Field(default=1.0, ge=0.0)  # noqa: N815
    #: Whole-song RMS below which a stem is dropped.
    silenceFloorDb: float = Field(default=pl.SILENCE_FLOOR_DB, le=0.0)  # noqa: N815


#: How the capability obtains a model. Replaced in tests; cached per (model, device).
BackendFactory = Callable[[str, str], pl.SeparationBackend]
_BACKENDS: dict[tuple[str, str], pl.SeparationBackend] = {}


def _load_demucs(model: str, device: str) -> pl.SeparationBackend:
    from bragi_analysis.separation.demucs_backend import DemucsBackend

    return DemucsBackend.load(model, device=device)


backend_factory: BackendFactory = _load_demucs


def _backend(model: str, device: str) -> pl.SeparationBackend:
    key = (model, device)
    if key not in _BACKENDS:
        _BACKENDS[key] = backend_factory(model, device)
    return _BACKENDS[key]


async def run(job: JobRequest, ctx: JobContext) -> JobOutputs:
    """Separates ``assets.mix`` into stems and a residual."""
    params = ParamsModel.model_validate(params_of(job))
    mix_hash = job.inputs.assets["mix"]
    started = time.perf_counter()

    data = await ctx.download(mix_hash)
    mix, rate = await asyncio.to_thread(decode_flac, data)
    if rate != pl.WORKING_RATE or mix.shape[0] != 2:
        raise ValueError(f"the working asset must be 48 kHz stereo, got {rate} Hz x {mix.shape[0]}")
    await ctx.progress(0.03)

    backend = await asyncio.to_thread(_backend, params.model, params.device)
    segment_sec = min(params.segmentSec, backend.max_segment_sec)
    segment = int(segment_sec * backend.sample_rate)
    overlap = min(int(params.overlapSec * backend.sample_rate), segment // 2)

    model_mix = pl.resample(mix, pl.WORKING_RATE, backend.sample_rate).astype(np.float32)
    chunks = pl.plan_chunks(model_mix.shape[-1], segment, overlap)
    stitcher = pl.Stitcher(len(backend.stem_names), 2, model_mix.shape[-1], chunks)
    for index, chunk in enumerate(chunks):
        if await ctx.cancelled():
            raise JobCancelledError(f"job {job.jobId} cancelled at chunk {index}")
        output = await asyncio.to_thread(backend.separate, model_mix[:, chunk.start : chunk.end])
        stitcher.add(index, output)
        await ctx.progress(0.05 + 0.80 * (index + 1) / len(chunks))
    stems = stitcher.finish()
    del model_mix

    result, assets = await _encode_and_upload(ctx, mix, stems, backend, params)
    _LOGGER.info(
        "separation done",
        extra={
            "job": job.jobId,
            "model": params.model,
            "chunks": len(chunks),
            "kept": [stem.role.value for stem in result.stems],
            "seconds": round(time.perf_counter() - started, 2),
        },
    )
    blob = await ctx.upload_json(result.model_dump_json(exclude_none=True))
    await ctx.progress(1.0)
    return JobOutputs(assets=assets, blobs={"separation": blob})


async def _encode_and_upload(
    ctx: JobContext,
    mix: pl.Audio,
    stems: pl.Stems,
    backend: pl.SeparationBackend,
    params: ParamsModel,
) -> tuple[SeparationResult, dict[str, str]]:
    accumulator = pl.ResidualAccumulator(mix)
    encoded: list[tuple[str, bytes, float]] = []
    levels: list[tuple[int, float]] = []

    # Pass 1: measure every stem at 48 kHz (one stem in memory at a time).
    for index in range(stems.shape[0]):
        stem = await asyncio.to_thread(_to_working_rate, stems[index], backend, mix.shape[-1])
        levels.append((index, pl.rms_db(stem)))
    keep = {index for index, level in levels if level >= params.silenceFloorDb}
    if not keep:  # a silent file: the schema needs one stem, so keep the loudest
        keep = {max(levels, key=lambda item: item[1])[0]}

    # Pass 2: encode the kept stems and fold the *stored* samples into the residual.
    for index, level in levels:
        if index not in keep:
            continue
        stem = await asyncio.to_thread(_to_working_rate, stems[index], backend, mix.shape[-1])
        data = await asyncio.to_thread(encode_flac, stem, pl.WORKING_RATE)
        stored, _ = await asyncio.to_thread(decode_flac, data)
        accumulator.add(stored)
        encoded.append((backend.stem_names[index], data, level))
        await ctx.progress(0.85 + 0.10 * len(encoded) / len(keep))

    residual = accumulator.residual()
    peak = float(np.max(np.abs(residual))) if residual.size else 0.0
    if peak > 1.0:
        _LOGGER.warning("residual overshoots full scale and was clipped", extra={"peak": peak})
    residual = pl.clip_full_scale(residual)
    residual_hash = await ctx.upload(
        await asyncio.to_thread(encode_flac, residual, pl.WORKING_RATE), "audio/flac"
    )

    assets: dict[str, str] = {"residual": residual_hash}
    entries: list[StemAsset] = []
    for name, data, level in encoded:
        digest = await ctx.upload(data, "audio/flac")
        assets[f"stem_{name}"] = digest
        entries.append(
            StemAsset(
                role=StemRole(name),
                asset=digest,
                rmsDb=None if math.isinf(level) else round(level, 2),
            )
        )
    result = SeparationResult(
        schemaVersion=SeparationResultSchemaVersion.integer_1,
        model=pin_for(params.model).stage_version,
        stems=entries,
        residual=residual_hash,
    )
    return result, assets


def _to_working_rate(stem: np.ndarray, backend: pl.SeparationBackend, total: int) -> pl.Audio:
    """One stem back at 48 kHz, exactly ``total`` samples, clipped to the FLAC range."""
    audio = pl.resample(stem.astype(np.float64), backend.sample_rate, pl.WORKING_RATE)
    return np.asarray(pl.clip_full_scale(pl.fit_length(audio, total)))


__all__ = ["CAPABILITY", "ParamsModel", "backend_factory", "run"]
