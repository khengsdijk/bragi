"""The ``harmony`` capability (``specs/04`` §5.3).

Estimates the key and the chords of a song and derives a key-invariant
``progressionFingerprint``. It reads the harmonic stems when the orchestrator
provides them (``assets.stem_bass``, ``stem_other``, ``stem_piano``,
``stem_guitar``, as 04 §5.3 asks), and falls back to ``assets.mix`` then
``assets.source`` so the stage still runs today (the orchestrator passes only the
upload hash — Q33). Optional ``rhythm`` and ``structure`` blobs switch on
beat-synchronous chroma and per-section progressions.

Outputs: ``blobs.harmony`` (a ``HarmonyResult``). A song with no analysable
harmony publishes a low-confidence result, never a failure (04 §1.3, §10).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Literal

import numpy as np
from pydantic import BaseModel, ConfigDict, Field

from bragi_analysis import media
from bragi_analysis.harmony import chords, chroma, pipeline
from bragi_common.cancel import JobCancelledError
from bragi_common.context import JobContext
from bragi_common.generated.models import (
    JobOutputs,
    JobRequest,
    RhythmResult,
    StructureResult,
)
from bragi_common.protocol import params_of

#: Capability name; the NATS subject is ``jobs.analysis.harmony.<priority>`` (05 §4.1).
CAPABILITY = "analysis.harmony"

#: The harmonic stems of 04 §5.3: chroma excludes drums and vocals.
HARMONIC_STEMS: tuple[str, ...] = ("bass", "other", "piano", "guitar")

MAX_DECODE_SEC = 31 * 60

_LOGGER = logging.getLogger("bragi_analysis.harmony")


class ParamsModel(BaseModel):
    """Parameters for ``analysis.harmony``."""

    model_config = ConfigDict(extra="forbid")

    #: ``auto`` and ``template`` both use the weight-free recogniser (ADR-0008).
    recognizer: Literal["auto", "template"] = "auto"
    #: Use a ``rhythm`` blob for beat-synchronous chroma when one was passed.
    useBeats: bool = True  # noqa: N815 - JSON field name
    #: Chord segments shorter than this are merged into their neighbour.
    minChordSec: float = Field(default=0.15, gt=0.0)  # noqa: N815
    #: Viterbi change penalty: higher is more stable, lower tracks faster.
    changePenalty: float = Field(default=0.25, ge=0.0)  # noqa: N815


def _input_assets(job: JobRequest) -> tuple[list[str], str]:
    """The asset keys to read and a label for the log: stems, else mix, else source."""
    assets = job.inputs.assets
    stems = [f"stem_{role}" for role in HARMONIC_STEMS if f"stem_{role}" in assets]
    if stems:
        return stems, "stems"
    for fallback in ("mix", "source"):
        if fallback in assets:
            return [fallback], fallback
    raise ValueError(
        "analysis.harmony needs assets.stem_{bass,other,piano,guitar} or assets.mix/source"
    )


async def _decode_harmonic_mix(
    job: JobRequest, ctx: JobContext, names: list[str]
) -> tuple[np.ndarray, float]:
    """Decodes the named assets to mono at the chroma rate and sums them."""
    rate = chroma.CHROMA_RATE
    parts: list[np.ndarray] = []
    for name in names:
        data = await ctx.download(job.inputs.assets[name])
        path = ctx.scratch_path(f"harmony_{name}.bin")
        await asyncio.to_thread(path.write_bytes, data)
        info = await media.probe(path)
        pcm = await media.decode_pcm(
            path,
            sample_rate=rate,
            channels=1,
            max_seconds=MAX_DECODE_SEC,
            declared_duration_sec=info.duration_sec,
        )
        parts.append(pcm[:, 0])
    length = max(part.shape[0] for part in parts)
    mono = np.zeros(length, dtype=np.float32)
    for part in parts:
        mono[: part.shape[0]] += part
    return mono, length / rate


async def _rhythm_beats(job: JobRequest, ctx: JobContext) -> np.ndarray | None:
    """Beats from an optional ``rhythm`` blob, or ``None``."""
    blob = (job.inputs.blobs or {}).get("rhythm")
    if blob is None:
        return None
    result = RhythmResult.model_validate_json(await ctx.download(blob))
    if not result.beats:
        return None
    return np.asarray(result.beats, dtype=np.float64)


async def _structure_sections(
    job: JobRequest, ctx: JobContext
) -> list[pipeline.SectionSpan] | None:
    """Structure sections from an optional ``structure`` blob, or ``None``."""
    blob = (job.inputs.blobs or {}).get("structure")
    if blob is None:
        return None
    result = StructureResult.model_validate_json(await ctx.download(blob))
    return [
        pipeline.SectionSpan(index=index, start_sec=section.startSec, end_sec=section.endSec)
        for index, section in enumerate(result.sections)
    ]


async def run(job: JobRequest, ctx: JobContext) -> JobOutputs:
    """Estimates the key and chords of the source and publishes a ``HarmonyResult``."""
    params = ParamsModel.model_validate(params_of(job))
    names, source_kind = _input_assets(job)

    mono, duration_sec = await _decode_harmonic_mix(job, ctx, names)
    await ctx.progress(0.4)
    if await ctx.cancelled():
        raise JobCancelledError(f"job {job.jobId} cancelled")

    beats = await _rhythm_beats(job, ctx) if params.useBeats else None
    sections = await _structure_sections(job, ctx)
    frames = await asyncio.to_thread(chroma.chroma_frames, mono, chroma.CHROMA_RATE)
    recognizer = chords.TemplateRecognizer(
        change_penalty=params.changePenalty, min_chord_sec=params.minChordSec
    )
    result = await asyncio.to_thread(
        pipeline.build_result,
        frames,
        duration_sec,
        beats=beats,
        sections=sections,
        recognizer=recognizer,
    )
    _LOGGER.info(
        "harmony done",
        extra={
            "job": job.jobId,
            "source": source_kind,
            "assets": names,
            "durationSec": round(duration_sec, 2),
            "chords": len(result.chords),
            "key": f"{result.key.tonic} {result.key.mode.value}",
            "lowConfidence": bool(result.lowConfidence),
        },
    )
    blob = await ctx.upload_json(result.model_dump_json(exclude_none=True))
    await ctx.progress(1.0)
    return JobOutputs(blobs={"harmony": blob})


__all__ = ["CAPABILITY", "HARMONIC_STEMS", "ParamsModel", "run"]
