"""The ``ingest`` capability (``specs/04`` §3.1).

Decodes the upload, rejects what the pipeline cannot or will not process, and
produces the **working asset**: 48 kHz, stereo, 24-bit FLAC. Also computes the
duration, a Chromaprint fingerprint and a peak pyramid for the Universe thumbnails.

Inputs: ``assets.source``. Outputs: ``assets.workingAsset`` and ``blobs.result``
(an ``IngestResult``).
"""

from __future__ import annotations

import asyncio
import hashlib

import numpy as np
from pydantic import BaseModel, ConfigDict, Field

from bragi_analysis import media
from bragi_common.cancel import JobCancelledError
from bragi_common.context import JobContext
from bragi_common.errors import JobFailure
from bragi_common.generated.models import (
    FreeformParams,
    IngestResult,
    IngestResultSchemaVersion,
    JobOutputs,
    JobRequest,
)
from bragi_common.protocol import params_of

CAPABILITY = "analysis.ingest"

#: The working asset's format (02 §3.4, 04 §3.1).
WORKING_SAMPLE_RATE = 48_000
WORKING_CHANNELS = 2

#: Defaults of 04 §3.1: reject files over 30 minutes or 500 MB.
DEFAULT_MAX_DURATION_SEC = 30 * 60
DEFAULT_MAX_BYTES = 500 * 1000 * 1000

#: Peak pyramid levels, in working-asset samples per min/max pair.
PEAK_LEVELS = (4096, 65_536)


class ParamsModel(BaseModel):
    """Parameters for ``ingest`` (the limits are configurable, 04 §3.1)."""

    model_config = ConfigDict(extra="forbid")

    maxDurationSec: float = Field(default=DEFAULT_MAX_DURATION_SEC, gt=0)  # noqa: N815
    maxBytes: int = Field(default=DEFAULT_MAX_BYTES, gt=0)  # noqa: N815


def peak_pyramid(mono: np.ndarray, levels: tuple[int, ...] = PEAK_LEVELS) -> dict[str, object]:
    """Min/max peaks of the mono mix at coarse levels of detail.

    Each level holds ``[min0, max0, min1, max1, ...]`` for consecutive blocks of
    ``samplesPerPeak`` samples; the last block may be shorter.
    """
    out: list[dict[str, object]] = []
    for size in levels:
        blocks = -(-mono.shape[0] // size)
        padded = np.full(blocks * size, np.nan, dtype=np.float32)
        padded[: mono.shape[0]] = mono
        shaped = padded.reshape(blocks, size)
        pairs = np.stack([np.nanmin(shaped, axis=1), np.nanmax(shaped, axis=1)], axis=1)
        out.append({"samplesPerPeak": size, "peaks": np.round(pairs.ravel(), 4).tolist()})
    return {"sampleRate": WORKING_SAMPLE_RATE, "levels": out}


async def _check_cancel(ctx: JobContext, job: JobRequest) -> None:
    if await ctx.cancelled():
        raise JobCancelledError(f"job {job.jobId} cancelled")


async def run(job: JobRequest, ctx: JobContext) -> JobOutputs:
    """Decode, validate, re-encode, fingerprint and describe one upload."""
    params = ParamsModel.model_validate(params_of(job))
    source_hash = job.inputs.assets["source"]

    data = await ctx.download(source_hash)
    if len(data) > params.maxBytes:
        raise JobFailure(
            "PAYLOAD_TOO_LARGE",
            f"This file is larger than the {params.maxBytes // 1_000_000} MB limit.",
        )
    await ctx.progress(0.1)
    await _check_cancel(ctx, job)

    source = ctx.scratch_path("source.bin")
    await asyncio.to_thread(source.write_bytes, data)
    del data

    info = await media.probe(source)
    too_long = JobFailure(
        "ASSET_TOO_LONG",
        f"This file is longer than the {params.maxDurationSec / 60:.0f} minute limit.",
    )
    if info.duration_sec is not None and info.duration_sec > params.maxDurationSec:
        raise too_long
    await ctx.progress(0.2)

    # Decode one second past the limit: a container that lies about its duration
    # still cannot make the worker decode an unbounded stream.
    pcm = await media.decode_pcm(
        source,
        sample_rate=WORKING_SAMPLE_RATE,
        channels=WORKING_CHANNELS,
        max_seconds=params.maxDurationSec + 1.0,
        declared_duration_sec=info.duration_sec,
        source_channels=info.channels,
    )
    duration_sec = pcm.shape[0] / WORKING_SAMPLE_RATE
    if duration_sec > params.maxDurationSec:
        raise too_long
    await ctx.progress(0.5)
    await _check_cancel(ctx, job)

    flac_path = ctx.scratch_path("working.flac")
    await media.encode_flac_24(pcm, WORKING_SAMPLE_RATE, flac_path)
    await ctx.progress(0.7)

    print_ = await media.fingerprint(flac_path)
    if print_ is None:
        # Too short for Chromaprint: key on the exact audio instead, so only an
        # identical clip is reported as a duplicate.
        digest = hashlib.sha256(np.ascontiguousarray(pcm).tobytes()).hexdigest()
        print_ = f"exact:{digest[:32]}"
    pyramid = await asyncio.to_thread(peak_pyramid, pcm.mean(axis=1))
    await ctx.progress(0.85)

    working_hash = await ctx.upload(await asyncio.to_thread(flac_path.read_bytes), "audio/flac")
    result = IngestResult(
        schemaVersion=IngestResultSchemaVersion.integer_1,
        workingAsset=working_hash,
        durationSec=duration_sec,
        channelsOriginal=info.channels,
        sampleRateOriginal=info.sample_rate,
        codec=info.codec,
        fingerprint=print_,
        peakPyramid=FreeformParams.model_validate(pyramid),
    )
    blob = await ctx.upload_json(result.model_dump_json(exclude_none=True))
    await ctx.progress(1.0)
    return JobOutputs(assets={"workingAsset": working_hash}, blobs={"result": blob})
