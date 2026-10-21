"""The two-sided capabilities' shared half: ``generate.inpaint`` and ``generate.transition``.

Both download a rendered context on each side, ask the routed backend for a middle
span, gate it at both seams and stream each passing candidate as a ``partial``
(09 §4.3-4.4, §5). They differ only in what the span means: an inpaint fills a gap
of missing audio, a transition replaces the section edges around a join. The spec
below is that difference; everything else lives here so the two modules stay thin.
"""

from __future__ import annotations

import asyncio
import math
from collections.abc import Callable
from dataclasses import dataclass, replace

from bragi_common.context import JobContext
from bragi_common.generated.models import (
    ExtendTier,
    GenerateFillResult,
    GenerateFillResultSchemaVersion,
    JobOutputs,
    JobRequest,
    MusicalContext,
)
from bragi_generate.audio import WORKING_RATE, decode
from bragi_generate.backend import FillRequest, GenOutput, Tier
from bragi_generate.capabilities import blobs, streaming
from bragi_generate.capabilities.streaming import Candidate
from bragi_generate.postprocess import Audio, FillGateRequest, FillGateResult, KeySpec
from bragi_generate.postprocess.config import GateConfig
from bragi_generate.routing import backend_for


@dataclass(frozen=True)
class FillSpec:
    """One two-sided request, independent of the capability's params schema."""

    capability: str
    context: MusicalContext
    gap_bars: int
    lead_bars: float
    overlap_bars: int
    tier: ExtendTier
    n: int
    seed: int | None = None
    prompt: str | None = None


def gen_request(spec: FillSpec, before: Audio, after: Audio) -> FillRequest:
    """The backend request from the validated params and both contexts."""
    signature = tuple(int(part) for part in spec.context.timeSignature)
    if len(signature) != 2:
        raise ValueError("timeSignature must have two entries")
    key = KeySpec.parse(spec.context.key.tonic, spec.context.key.mode.value)
    return FillRequest(
        capability=spec.capability,
        before=before,
        after=after,
        bpm=float(spec.context.bpm),
        time_signature=(signature[0], signature[1]),
        key=key,
        gap_bars=spec.gap_bars,
        lead_bars=spec.lead_bars,
        overlap_bars=spec.overlap_bars,
        descriptors=tuple(spec.context.descriptors),
        seed=spec.seed if spec.seed is not None else spec.context.seed,
        prompt=spec.prompt,
        section_kind=(
            spec.context.sectionKind.value if spec.context.sectionKind is not None else None
        ),
        energy=spec.context.energy,
        chords=(
            tuple((float(chord.startBeat), chord.symbol) for chord in spec.context.chords)
            if spec.context.chords is not None
            else ()
        ),
    )


def gate_request(spec: FillSpec) -> FillGateRequest:
    """The gates' grid, from the same params."""
    signature = tuple(int(part) for part in spec.context.timeSignature)
    return FillGateRequest(
        bpm=float(spec.context.bpm),
        time_signature=(signature[0], signature[1]),
        key=KeySpec.parse(spec.context.key.tonic, spec.context.key.mode.value),
        gap_bars=spec.gap_bars,
        lead_bars=spec.lead_bars,
        overlap_bars=spec.overlap_bars,
    )


def fit_overlap(spec: FillSpec, before: Audio, after: Audio, seam_window_sec: float) -> FillSpec:
    """Lowers the overlap to what both contexts can hold (at least one bar).

    A gap near the song's start or end has less context than the requested overlap plus a seam
    window on that side; the splice search then runs on a shorter overlap instead of failing.
    """
    beats, _ = (int(part) for part in spec.context.timeSignature)
    bar_sec = 60.0 / float(spec.context.bpm) * beats
    lead_sec = spec.lead_bars * bar_sec
    shortest = min(before.duration_sec, after.duration_sec) - lead_sec - seam_window_sec
    fits = math.floor(shortest / bar_sec + 1e-9) if bar_sec > 0 else 0
    if fits < 1:
        raise ValueError(
            "the gap is too close to the song's edge: each side needs at least one bar of "
            "context plus a seam window"
        )
    overlap = min(spec.overlap_bars, fits)
    return spec if overlap == spec.overlap_bars else replace(spec, overlap_bars=overlap)


def tier_of(tier: ExtendTier) -> Tier:
    """The generated enum as the backend protocol's literal."""
    return "preview" if tier == ExtendTier.preview else "hq"


async def run_fill(
    job: JobRequest,
    ctx: JobContext,
    spec: FillSpec,
    gates: Callable[[Audio, Audio, Audio, FillGateRequest], FillGateResult],
) -> JobOutputs:
    """Generates and gates up to ``n`` two-sided candidates for one request."""
    before, after = await _load_contexts(job, ctx)
    spec = fit_overlap(spec, before, after, GateConfig.load().seam_window_sec)
    request = gen_request(spec, before, after)
    grid = gate_request(spec)
    tier = tier_of(spec.tier)

    backend = backend_for(spec.capability, tier)
    if spec.capability not in backend.capabilities:
        raise ValueError(f"backend {backend.name!r} does not implement {spec.capability}")
    if not backend.supports_audio_context:
        raise ValueError(f"backend {backend.name!r} cannot condition on context audio")

    def attempt(seed: int) -> tuple[GenOutput, FillGateResult]:
        outputs = backend.generate_fill(replace(request, seed=seed), tier, 1, _ignore_progress)
        if not outputs:
            raise RuntimeError(f"backend {backend.name!r} returned no candidate")
        output = outputs[0]
        return output, gates(output.audio, before, after, grid)

    async def publish(
        candidate: Candidate[FillGateResult], quality_warning: bool
    ) -> Candidate[FillGateResult]:
        asset, blob = await blobs.upload(
            ctx,
            candidate.gate.processed,
            lambda hash_: _result(candidate, hash_, quality_warning=quality_warning),
            required=("seamScore", "endSeamScore"),
        )
        return replace(candidate, asset=asset, blob=blob)

    streamed = await streaming.stream(
        job,
        ctx,
        capability=spec.capability,
        backend=backend,
        target=spec.n,
        base_seed=request.seed,
        generate=attempt,
        passed=lambda gate: gate.passed,
        sort_score=_gate_score,
        publish=publish,
        outputs=lambda items: _outputs(*items),
    )
    return _outputs(*streamed.accepted)


async def _load_contexts(job: JobRequest, ctx: JobContext) -> tuple[Audio, Audio]:
    """Downloads and decodes ``inputs.assets.before`` and ``inputs.assets.after``."""
    contexts: list[Audio] = []
    for name in ("before", "after"):
        content_hash = job.inputs.assets.get(name)
        if content_hash is None:
            raise ValueError(
                f"{job.capability} needs inputs.assets.{name} "
                f"(the rendered context on each side of the span)"
            )
        data = await ctx.download(content_hash)
        audio = await asyncio.to_thread(decode, data)
        if audio.sample_rate != WORKING_RATE:
            raise ValueError(
                f"the {name} context must be {WORKING_RATE} Hz, got {audio.sample_rate}"
            )
        contexts.append(audio)
    return contexts[0], contexts[1]


def _gate_score(gate: FillGateResult) -> float:
    """The worse of the two seams: the fallback should be the best at both."""
    return max(gate.seam_score, gate.end_seam_score)


def _ignore_progress(_pct: float) -> None:
    """The backend's own progress is folded into the capability's attempt counter."""


def _result(
    candidate: Candidate[FillGateResult], asset: str, *, quality_warning: bool
) -> GenerateFillResult:
    """The JSON-safe result blob (``inf`` becomes ``null``, 09 §6)."""
    gate = candidate.gate
    return GenerateFillResult(
        schemaVersion=GenerateFillResultSchemaVersion.integer_1,
        index=candidate.index,
        asset=asset,
        seed=candidate.output.seed,
        model=candidate.output.model,
        modelVersion=candidate.output.model_version,
        passed=gate.passed,
        qualityWarning=quality_warning,
        seamScore=gate.seam_score if math.isfinite(gate.seam_score) else None,
        endSeamScore=gate.end_seam_score if math.isfinite(gate.end_seam_score) else None,
        tempoError=gate.tempo_error if math.isfinite(gate.tempo_error) else 0.0,
        keyMatch=blobs.key_match_model(gate.key_match),
        matchEq=blobs.match_eq_model(gate.match_eq),
        startOffsetSamples=gate.start_offset_samples,
        endOffsetSamples=gate.end_offset_samples,
        steps=blobs.step_models(gate),
    )


def _outputs(*candidates: Candidate[FillGateResult]) -> JobOutputs:
    """The job outputs: one asset and one result blob per candidate."""
    assets: dict[str, str] = {}
    blobs_by_index: dict[str, str] = {}
    for candidate in candidates:
        if candidate.asset is None or candidate.blob is None:
            continue
        assets[f"candidate_{candidate.index}"] = candidate.asset
        blobs_by_index[f"candidate_{candidate.index}"] = candidate.blob
    return JobOutputs(assets=assets or None, blobs=blobs_by_index or None)


__all__ = ["FillSpec", "gate_request", "gen_request", "run_fill", "tier_of"]
