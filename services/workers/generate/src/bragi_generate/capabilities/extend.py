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
import json
import logging
import math
from collections.abc import Mapping
from dataclasses import dataclass, replace

from bragi_common.cancel import JobCancelledError
from bragi_common.context import JobContext
from bragi_common.generated.models import (
    ExtendDirection,
    ExtendKeyMatch,
    ExtendKeyRelation,
    ExtendMatchEq,
    ExtendStep,
    ExtendTier,
    GenerateExtendParams,
    GenerateExtendResult,
    GenerateExtendResultSchemaVersion,
    JobMetrics,
    JobOutputs,
    JobRequest,
    KeyMode,
    MusicalKey,
)
from bragi_common.protocol import params_of
from bragi_generate import routing
from bragi_generate.audio import WORKING_RATE, decode, encode_flac
from bragi_generate.backend import Direction, GenOutput, GenRequest, Tier
from bragi_generate.postprocess import Audio, GateRequest, GateResult, KeySpec, postprocess
from bragi_generate.postprocess.types import NOTE_NAMES

#: Capability name; the NATS subject is ``jobs.generate.extend.<priority>`` (05 §4.1).
CAPABILITY = "generate.extend"
#: 09 §6: the initial round plus two rounds of new seeds.
ROUNDS = 3
_LOGGER = logging.getLogger("bragi_generate.extend")


@dataclass(frozen=True)
class _Candidate:
    """One generated and gated candidate, before or after upload."""

    index: int
    output: GenOutput
    gate: GateResult
    asset: str | None = None
    blob: str | None = None

    @property
    def sort_key(self) -> tuple[float, int]:
        """Best first: a finite seam score, then generation order."""
        score = self.gate.seam_score
        return (score if math.isfinite(score) else math.inf, self.output.seed)


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
    target = params.n
    accepted: list[_Candidate] = []
    failures: list[_Candidate] = []
    attempts = 0
    total_gpu_sec = 0.0
    last: GenOutput | None = None

    for round_index in range(ROUNDS):
        missing = target - len(accepted)
        if missing <= 0:
            break
        for slot in range(missing):
            if await ctx.cancelled():
                raise JobCancelledError(f"job {job.jobId} cancelled at candidate {attempts}")
            seed = (request.seed + round_index * 16 + slot) & 0xFFFFFFFF
            outputs = await asyncio.to_thread(
                backend.generate, replace(request, seed=seed), tier, 1, _ignore_progress
            )
            if not outputs:
                raise RuntimeError(f"backend {backend.name!r} returned no candidate")
            output = outputs[0]
            last = output
            total_gpu_sec += output.timings.generate_sec
            attempts += 1

            result = await asyncio.to_thread(run_gates, output.audio, context, gate_request)
            if result.passed:
                uploaded = await _upload(ctx, _Candidate(len(accepted), output, result))
                accepted.append(uploaded)
                await ctx.partial(_outputs(uploaded))
            else:
                failures.append(_Candidate(-1, output, result))
            await ctx.progress(_progress(attempts, target), _eta(attempts, target, total_gpu_sec))

    if not accepted:
        if not failures:
            raise RuntimeError("no candidate was produced")
        best = min(failures, key=lambda candidate: candidate.sort_key)
        accepted.append(await _upload(ctx, replace(best, index=0), quality_warning=True))

    if last is not None:
        ctx.record_metrics(
            JobMetrics(
                gpuSeconds=round(total_gpu_sec, 3),
                model=last.model,
                modelVersion=last.model_version,
                worker=f"bragi-generate:{backend.name}",
            )
        )
    await ctx.progress(1.0)
    _LOGGER.info(
        "extend done",
        extra={
            "job": job.jobId,
            "backend": backend.name,
            "accepted": len(accepted),
            "attempts": attempts,
            "seconds": round(total_gpu_sec, 2),
        },
    )
    return _outputs(*accepted)


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
        seed=params.context.seed,
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


def _progress(attempts: int, target: int) -> float:
    """Attempt-based progress, capped below 1 until the job really finishes."""
    return min(0.95, 0.05 + 0.90 * attempts / (target * ROUNDS))


def _eta(attempts: int, target: int, seconds: float) -> float | None:
    """A naive remaining-time estimate from the average attempt."""
    if attempts <= 0 or seconds <= 0.0:
        return None
    return round(seconds / attempts * max(1, target * ROUNDS - attempts), 1)


async def _upload(
    ctx: JobContext, candidate: _Candidate, *, quality_warning: bool = False
) -> _Candidate:
    """Uploads the processed audio and its result blob."""
    data = await asyncio.to_thread(encode_flac, candidate.gate.processed)
    asset = await ctx.upload(data, "audio/flac")
    result = _result(candidate, asset, quality_warning=quality_warning)
    # `exclude_none` drops the optional keyMatch/matchEq, but seamScore is required
    # and null is meaningful (the gates could not score it), so re-add it.
    document = result.model_dump(mode="json", exclude_none=True)
    document["seamScore"] = result.seamScore
    blob = await ctx.upload_json(json.dumps(document, separators=(",", ":")))
    return replace(candidate, asset=asset, blob=blob)


def _result(candidate: _Candidate, asset: str, *, quality_warning: bool) -> GenerateExtendResult:
    """The JSON-safe result blob of 09 §6 (``inf`` becomes ``null``)."""
    gate = candidate.gate
    key_match: ExtendKeyMatch | None = None
    if gate.key_match is not None:
        key_match = ExtendKeyMatch(
            detected=MusicalKey(
                tonic=NOTE_NAMES[gate.key_match.detected.tonic_pc],
                mode=KeyMode(gate.key_match.detected.mode),
            ),
            confidence=gate.key_match.confidence,
            relation=ExtendKeyRelation(gate.key_match.relation),
            shiftSemitones=gate.key_match.shift_semitones,
        )
    match_eq = (
        ExtendMatchEq(bands=list(gate.match_eq.bands), amount=gate.match_eq.amount)
        if gate.match_eq is not None
        else None
    )
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
        keyMatch=key_match,
        matchEq=match_eq,
        spliceOffsetSamples=gate.splice_offset_samples,
        direction=ExtendDirection(gate.direction),
        steps=[
            ExtendStep(
                step=verdict.step,
                passed=verdict.passed,
                skipped=verdict.skipped,
                reason=verdict.reason,
                metrics=_metrics(verdict.metrics),
            )
            for verdict in gate.steps
        ],
    )


def _metrics(values: Mapping[str, object]) -> dict[str, object]:
    """Gate metrics as JSON values: non-finite floats become ``null``."""
    clean: dict[str, object] = {}
    for name, value in values.items():
        if isinstance(value, bool | int | str):
            clean[name] = value
        elif isinstance(value, float):
            clean[name] = value if math.isfinite(value) else None
        else:
            item = getattr(value, "item", None)
            clean[name] = item() if callable(item) else str(value)
    return clean


def _outputs(*candidates: _Candidate) -> JobOutputs:
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
