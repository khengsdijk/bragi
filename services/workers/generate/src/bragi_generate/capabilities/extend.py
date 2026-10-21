"""The ``generate.extend`` capability (``specs/09-generation.md`` §4.2, §6).

Flow: download the rendered context, resolve the ``(capability, tier)`` route, ask
the backend for candidates, and run every candidate through the quality gates. A
passing candidate is uploaded and published as a ``partial`` immediately, so the
Audition bar can play it while the rest are still generating (09 §5). Failed
candidates are regenerated with new seeds for up to two extra rounds; if none pass,
the best one is returned with ``qualityWarning`` (09 §6).

The candidate audio is the processed tail (forward) or head (backward) only; its
placement offset comes from ``spliceOffsetSamples``. Nothing here touches the song
document: placement is task E.
"""

from __future__ import annotations

import asyncio
import logging
import math
from dataclasses import replace

from bragi_common.context import JobContext
from bragi_common.generated.models import (
    ExtendDirection,
    ExtendTier,
    GenerateExtendParams,
    GenerateExtendResult,
    GenerateExtendResultSchemaVersion,
    JobOutputs,
    JobRequest,
)
from bragi_common.protocol import params_of
from bragi_generate import routing
from bragi_generate.audio import WORKING_RATE, decode
from bragi_generate.backend import Direction, GenOutput, GenRequest, Tier
from bragi_generate.capabilities import blobs, streaming
from bragi_generate.capabilities.streaming import ROUNDS, Candidate
from bragi_generate.postprocess import Audio, GateRequest, GateResult, KeySpec, postprocess

#: Capability name; the NATS subject is ``jobs.generate.extend.<priority>`` (05 §4.1).
CAPABILITY = "generate.extend"
_LOGGER = logging.getLogger("bragi_generate.extend")


def run_gates(candidate: Audio, context: Audio, request: GateRequest) -> GateResult:
    """Runs the seven gates of 09 §6. A seam for tests to substitute a verdict."""
    return postprocess(candidate, context, request)


async def run(job: JobRequest, ctx: JobContext) -> JobOutputs:
    """Generates and gates up to ``n`` candidates for one extend request."""
    params = GenerateExtendParams.model_validate(params_of(job))
    context = await _load_context(job, ctx)
    request = _gen_request(params, context)
    tier = _tier(params.tier)

    backend = routing.backend_for(CAPABILITY, tier)
    if CAPABILITY not in backend.capabilities:
        raise ValueError(f"backend {backend.name!r} does not implement {CAPABILITY}")
    if not backend.supports_audio_context:
        raise ValueError(f"backend {backend.name!r} cannot condition on context audio")

    gate_request = GateRequest(
        bpm=request.bpm,
        time_signature=request.time_signature,
        key=request.key,
        bars=request.bars,
        overlap_bars=request.overlap_bars,
        direction=request.direction,
    )

    def attempt(seed: int) -> tuple[GenOutput, GateResult]:
        outputs = backend.generate(replace(request, seed=seed), tier, 1, _ignore_progress)
        if not outputs:
            raise RuntimeError(f"backend {backend.name!r} returned no candidate")
        output = outputs[0]
        return output, run_gates(output.audio, context, gate_request)

    async def publish(
        candidate: Candidate[GateResult], quality_warning: bool
    ) -> Candidate[GateResult]:
        return await _upload(ctx, candidate, quality_warning=quality_warning)

    streamed = await streaming.stream(
        job,
        ctx,
        capability=CAPABILITY,
        backend=backend,
        target=params.n,
        base_seed=request.seed,
        generate=attempt,
        passed=_gate_passed,
        sort_score=_gate_score,
        publish=publish,
        outputs=lambda items: _outputs(*items),
    )
    return _outputs(*streamed.accepted)


async def _load_context(job: JobRequest, ctx: JobContext) -> Audio:
    """Downloads and decodes ``inputs.assets.context``."""
    content_hash = job.inputs.assets.get("context")
    if content_hash is None:
        raise ValueError("generate.extend needs inputs.assets.context")
    data = await ctx.download(content_hash)
    context = await asyncio.to_thread(decode, data)
    if context.sample_rate != WORKING_RATE:
        raise ValueError(f"the context must be {WORKING_RATE} Hz, got {context.sample_rate}")
    return context


def _tier(tier: ExtendTier) -> Tier:
    """The generated enum as the backend protocol's literal."""
    return "preview" if tier == ExtendTier.preview else "hq"


def _direction(direction: ExtendDirection) -> Direction:
    """The generated enum as the backend protocol's literal."""
    return "forward" if direction == ExtendDirection.forward else "backward"


def _gen_request(params: GenerateExtendParams, context: Audio) -> GenRequest:
    """The backend request from the validated params."""
    signature = tuple(int(part) for part in params.context.timeSignature)
    if len(signature) != 2:
        raise ValueError("timeSignature must have two entries")
    key = KeySpec.parse(params.context.key.tonic, params.context.key.mode.value)
    return GenRequest(
        capability=CAPABILITY,
        context=context,
        bpm=float(params.context.bpm),
        time_signature=(signature[0], signature[1]),
        key=key,
        bars=params.bars,
        overlap_bars=params.overlapBars or 2,
        direction=_direction(params.direction),
        descriptors=tuple(params.context.descriptors),
        seed=params.seed if params.seed is not None else params.context.seed,
        prompt=params.prompt,
        section_kind=(
            params.context.sectionKind.value if params.context.sectionKind is not None else None
        ),
        energy=params.context.energy,
        chords=(
            tuple((float(chord.startBeat), chord.symbol) for chord in params.context.chords)
            if params.context.chords is not None
            else ()
        ),
    )


def _ignore_progress(_pct: float) -> None:
    """The backend's own progress is folded into the capability's attempt counter."""


def _gate_passed(gate: GateResult) -> bool:
    """A gate result counts when every non-skipped step passed (09 §6)."""
    return gate.passed


def _gate_score(gate: GateResult) -> float:
    """The candidate's seam score, for picking the best rejected fallback."""
    return gate.seam_score


async def _upload(
    ctx: JobContext, candidate: Candidate[GateResult], *, quality_warning: bool = False
) -> Candidate[GateResult]:
    """Uploads the processed audio and its result blob."""
    asset, blob = await blobs.upload(
        ctx,
        candidate.gate.processed,
        lambda hash_: _result(candidate, hash_, quality_warning=quality_warning),
        required=("seamScore",),
    )
    return replace(candidate, asset=asset, blob=blob)


def _result(
    candidate: Candidate[GateResult], asset: str, *, quality_warning: bool
) -> GenerateExtendResult:
    """The JSON-safe result blob of 09 §6 (``inf`` becomes ``null``)."""
    gate = candidate.gate
    return GenerateExtendResult(
        schemaVersion=GenerateExtendResultSchemaVersion.integer_1,
        index=candidate.index,
        asset=asset,
        seed=candidate.output.seed,
        model=candidate.output.model,
        modelVersion=candidate.output.model_version,
        passed=gate.passed,
        qualityWarning=quality_warning,
        seamScore=gate.seam_score if math.isfinite(gate.seam_score) else None,
        tempoError=gate.tempo_error if math.isfinite(gate.tempo_error) else 0.0,
        keyMatch=blobs.key_match_model(gate.key_match),
        matchEq=blobs.match_eq_model(gate.match_eq),
        spliceOffsetSamples=gate.splice_offset_samples,
        direction=ExtendDirection(gate.direction),
        steps=blobs.step_models(gate),
    )


def _outputs(*candidates: Candidate[GateResult]) -> JobOutputs:
    """The job outputs: one asset and one result blob per candidate."""
    assets: dict[str, str] = {}
    blobs: dict[str, str] = {}
    for candidate in candidates:
        if candidate.asset is None or candidate.blob is None:
            continue
        assets[f"candidate_{candidate.index}"] = candidate.asset
        blobs[f"candidate_{candidate.index}"] = candidate.blob
    return JobOutputs(assets=assets or None, blobs=blobs or None)


#: The capability contract's names (13 §3).
ParamsModel = GenerateExtendParams


__all__ = ["CAPABILITY", "ROUNDS", "ParamsModel", "run", "run_gates"]
