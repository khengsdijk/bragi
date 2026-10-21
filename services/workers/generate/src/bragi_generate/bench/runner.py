"""The generation bench behind ``pnpm bench:generate`` (09 §9 check 1, WP-2.8).

For each fixture song it renders the context(s) a job would carry, builds the
``generate.extend`` / ``generate.inpaint`` / ``generate.transition`` job the API would
submit (preview, ``n`` candidates), and runs it **through the capability the worker
runs** — routing → backend → the gates → regeneration rounds — with a local
:class:`~bragi_generate.bench.context.BenchContext` instead of NATS/S3. The report
records every attempt and candidate, the check verdict, the per-step gate pass rate,
the seam distribution and the time to the first passing candidate.

``--capability inpaint`` cuts a four-bar gap out of each song mid-song and renders
~15 s of context on each side on bar lines; ``--capability transition`` takes the
2 bars across a mid-song bar line. Extend stays the default and is unchanged.

The model is whatever the route selects; ``--backend fake`` forces the synthetic
backend for a fast smoke test. With ``--keep-audio`` the processed candidates and a
context + candidate + context preview land in ``bench-results/`` for the owner's
blind listening sheet (``docs/wp/2.8-MANUAL_CHECKS.md``).
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import math
import os
import random
import sys
import time
from collections.abc import Callable, Coroutine, Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Any, Literal, cast

import numpy as np
import soundfile as sf

from bragi_common.context import JobContext
from bragi_common.generated.models import (
    FreeformParams,
    GenerateExtendResult,
    GenerateFillResult,
    JobInputs,
    JobOutputs,
    JobPriority,
    JobRequest,
    JobRequestSchemaVersion,
)
from bragi_generate import routing
from bragi_generate.audio import WORKING_RATE, decode, encode_wav
from bragi_generate.bench import fixtures as bench_fixtures
from bragi_generate.bench.context import BenchContext
from bragi_generate.bench.fixtures import Fixture
from bragi_generate.bench.report import (
    CHECK1_CANDIDATES,
    CHECK1_SONGS,
    TIMING_LABEL,
    AggregateReport,
    AttemptReport,
    BenchReport,
    CandidateReport,
    FixtureReport,
    SeamStats,
    check_one,
    machine_label,
    now,
    process_peak_mb,
    seam_stats,
    server_peak_mb,
    step_rates,
    timing_stats,
)
from bragi_generate.capabilities import extend, inpaint, streaming, transition
from bragi_generate.postprocess import (
    Audio,
    FillGateResult,
    GateConfig,
    GateResult,
    seam,
    tonality,
)
from bragi_generate.postprocess import tempo as tempo_step
from bragi_generate.postprocess.pipeline import STEP_NAMES
from bragi_generate.postprocess.types import NOTE_NAMES

#: 09 §6 asks for two bars of overlap for an extend; the gate searches the splice in it.
OVERLAP_BARS = 2
#: A transition's schema has no overlap field; one bar each side holds the splices.
FILL_OVERLAP_BARS = 2
#: Fills render a ~15 s context on each side, on bar lines (WP-2.8 task A).
FILL_CONTEXT_TARGET_SEC = 15.0
#: The transition contexts are "end of A / start of B, up to 8 bars" (09 §4.4).
TRANSITION_CONTEXT_BARS = 8
#: The base seed of every job; the capability derives one per attempt from it.
BASE_SEED = 1234
#: Default output directory (git-ignored, like the planner bench's). Resolved against
#: the repository root because ``uv run --directory services/workers`` changes the
#: process's working directory before the module starts.
RESULTS_DIR = Path("bench-results")
#: The bench has no JSON schema of its own; the report is a measurement artifact.
REPORT_VERSION = 1
#: Bars of new audio / gap / bridge, per capability (the task's defaults).
DEFAULT_BARS: dict[str, int] = {"extend": 8, "inpaint": 4, "transition": 2}
#: The capability modules, their names and their entry points (13 §3).
CAPABILITY_MODULES: dict[str, ModuleType] = {
    "extend": extend,
    "inpaint": inpaint,
    "transition": transition,
}
CAPABILITY_NAMES: dict[str, str] = {
    "extend": extend.CAPABILITY,
    "inpaint": inpaint.CAPABILITY,
    "transition": transition.CAPABILITY,
}
CAPABILITY_RUNS: dict[str, Callable[[JobRequest, JobContext], Coroutine[Any, Any, JobOutputs]]] = {
    "extend": extend.run,
    "inpaint": inpaint.run,
    "transition": transition.run,
}
#: Candidate/attempt rows are printed in this order.
_TIER: Literal["preview"] = "preview"


@dataclass(frozen=True)
class BenchOptions:
    """One run's settings, after the CLI has validated them."""

    backend: str
    capability: str = "extend"
    fixtures: str | None = None
    n: int = 3
    bars: int | None = None
    out: Path = RESULTS_DIR
    keep_audio: bool = False
    quiet: bool = False

    @property
    def span_bars(self) -> int:
        """The bars the capability is asked for (its default when unset)."""
        return self.bars if self.bars is not None else DEFAULT_BARS[self.capability]


@dataclass(frozen=True)
class _Span:
    """The fixture's rendered context(s) and the params of the job they feed."""

    params: dict[str, object]
    payloads: dict[str, bytes]
    #: The audio the report's tempo/key reading describes (extend's context or a
    #: fill's left context).
    analysis: Audio
    context_bars: int
    context_sec: float
    gap_start_bar: int | None = None
    boundary_bar: int | None = None
    before: Audio | None = None
    after: Audio | None = None


@dataclass(frozen=True)
class _GateRun:
    """One gate pass and how long it took."""

    result: GateResult | FillGateResult
    seconds: float


@dataclass(frozen=True)
class _KeptAudio:
    """Audio the report points at, held until the blind labels are assigned."""

    fixture: str
    candidate_index: int
    seed: int
    candidate: Audio
    splice: Audio


def run_bench(options: BenchOptions) -> BenchReport:
    """Runs every selected fixture and returns (and writes) the report."""
    with _forced_backend(options.backend):
        return _run_bench(options)


@contextmanager
def _forced_backend(name: str) -> Iterator[None]:
    """Forces one backend through the routing override, restoring the environment after.

    The capability resolves its backend through the real routing table (09 §3.1), so
    the bench selects one the same way a deployment would — with the documented
    override, read by ``routing.backend_for()`` when the capability calls it.
    """
    previous = os.environ.get(routing.ENV_OVERRIDE)
    os.environ[routing.ENV_OVERRIDE] = name
    try:
        yield
    finally:
        if previous is None:
            os.environ.pop(routing.ENV_OVERRIDE, None)
        else:
            os.environ[routing.ENV_OVERRIDE] = previous


def _run_bench(options: BenchOptions) -> BenchReport:
    """The run itself; :func:`run_bench` owns the backend override."""
    routed = routing.backend_name(CAPABILITY_NAMES[options.capability], _TIER)
    if routed != options.backend:
        raise RuntimeError(f"routing selected {routed!r}, not {options.backend!r}")
    fixtures = bench_fixtures.select(options.fixtures)
    started_at = now()
    started = time.perf_counter()
    reports: list[FixtureReport] = []
    kept: list[_KeptAudio] = []
    for fixture in fixtures:
        device, audio = _run_fixture(fixture, options)
        reports.append(device)
        kept.extend(audio)

    out = options.out
    out.mkdir(parents=True, exist_ok=True)
    audio_dir = out / "audio" if options.keep_audio else None
    listening: list[tuple[str, FixtureReport, CandidateReport]] = []
    if audio_dir is not None:
        listening = _keep_audio(fixtures, reports, kept, audio_dir, options.capability)

    attempts = [attempt for report in reports for attempt in report.attempts]
    candidates = [candidate for report in reports for candidate in report.candidates]
    passing = [candidate for candidate in candidates if candidate.passed]
    status, detail = check_one(reports, options.n)
    fill = options.capability != "extend"
    aggregates = AggregateReport(
        fixtures=len(reports),
        attempts=len(attempts),
        candidates=len(candidates),
        passing_candidates=len(passing),
        fixtures_with_two_passing=sum(1 for report in reports if report.passing >= 2),
        check1=status,
        check1_detail=detail,
        step_rates=step_rates(attempts),
        seam_passing=seam_stats(
            candidate.seam_score for candidate in passing if candidate.seam_score is not None
        ),
        seam_scored=seam_stats(
            attempt.seam_score for attempt in attempts if attempt.seam_score is not None
        ),
        end_seam_passing=(
            seam_stats(
                candidate.end_seam_score
                for candidate in passing
                if candidate.end_seam_score is not None
            )
            if fill
            else None
        ),
        end_seam_scored=(
            seam_stats(
                attempt.end_seam_score for attempt in attempts if attempt.end_seam_score is not None
            )
            if fill
            else None
        ),
        time_to_first_pass=timing_stats(
            report.time_to_first_pass_sec
            for report in reports
            if report.time_to_first_pass_sec is not None
        ),
        regeneration_rounds=sum(report.regeneration_rounds for report in reports),
        total_sec=round(time.perf_counter() - started, 3),
        peak_process_mb=process_peak_mb(),
        peak_server_mb=server_peak_mb(_serve_pid_file()) if options.backend == "ace_step" else None,
    )

    report = BenchReport(
        machine=machine_label(),
        backend=options.backend,
        capability=options.capability,
        n=options.n,
        bars=options.span_bars,
        base_seed=BASE_SEED,
        started_at=started_at,
        finished_at=now(),
        fixtures=reports,
        aggregates=aggregates,
        results_path=str(
            out / f"generate-{started_at.replace(':', '-')}-{options.backend}-"
            f"{options.capability}.json"
        ),
        audio_dir=str(audio_dir) if audio_dir is not None else None,
    )
    if audio_dir is not None:
        _write_listening_order(listening, audio_dir, options.capability)
    _write_report(report, out)
    if not options.quiet:
        _print_summary(report, listening)
    return report


def _run_fixture(fixture: Fixture, options: BenchOptions) -> tuple[FixtureReport, list[_KeptAudio]]:
    """Runs one fixture through the selected capability and measures it."""
    span = _span(fixture, options)
    job = _job(fixture, options, span)
    ctx = BenchContext(span.payloads)
    gates: list[_GateRun] = []
    started = time.perf_counter()
    with _capture_gates(CAPABILITY_MODULES[options.capability], gates):
        # The capability is typed against the framework's context; the bench implements
        # the same surface in memory (05 §4.3).
        outputs = asyncio.run(CAPABILITY_RUNS[options.capability](job, cast(JobContext, ctx)))
    total_sec = time.perf_counter() - started

    detected_bpm, _beats = tempo_step.beat_times(span.analysis)
    detected_key, detected_confidence = tonality.detect(span.analysis)
    attempts = _attempts(gates, options.n)
    candidates = _candidates(outputs, ctx, attempts, options.capability)
    passing = sum(1 for candidate in candidates if candidate.passed)
    first_pass = min((partial.at_sec for partial in ctx.partials), default=None)
    kept = _kept_audio(ctx, candidates, span, fixture) if options.keep_audio else []

    report = FixtureReport(
        id=fixture.id,
        title=fixture.title,
        bpm=fixture.bpm,
        time_signature=list(fixture.time_signature),
        key_requested=fixture.key_label,
        capability=options.capability,
        bars=options.span_bars,
        gap_start_bar=span.gap_start_bar,
        gap_bars=options.span_bars if options.capability == "inpaint" else None,
        boundary_bar=span.boundary_bar,
        context_bars=span.context_bars,
        context_sec=round(span.context_sec, 3),
        detected_context_tempo_bpm=round(detected_bpm, 3),
        detected_context_key=detected_key.label,
        detected_context_key_confidence=round(detected_confidence, 3),
        attempts=attempts,
        candidates=candidates,
        passing=passing,
        regeneration_rounds=max((attempt.round for attempt in attempts), default=0),
        time_to_first_pass_sec=round(first_pass, 3) if first_pass is not None else None,
        total_sec=round(total_sec, 3),
        gpu_seconds=ctx.metrics.gpuSeconds if ctx.metrics is not None else None,
        model=ctx.metrics.model if ctx.metrics is not None else None,
        peak_process_mb=process_peak_mb(),
    )
    return report, kept


def _span(fixture: Fixture, options: BenchOptions) -> _Span:
    """Renders the fixture's context(s) and builds the capability's params."""
    if options.capability == "extend":
        return _extend_span(fixture, options)
    if options.capability == "inpaint":
        return _inpaint_span(fixture, options)
    return _transition_span(fixture, options)


def _base_context(fixture: Fixture) -> dict[str, object]:
    """The ``MusicalContext`` every capability's params nest (09 §2.1)."""
    return {
        "bpm": fixture.bpm,
        "timeSignature": list(fixture.time_signature),
        "key": {"tonic": NOTE_NAMES[fixture.key.tonic_pc], "mode": fixture.key.mode},
        "descriptors": list(fixture.descriptors),
        "seed": BASE_SEED,
    }


def _extend_span(fixture: Fixture, options: BenchOptions) -> _Span:
    """Extend's context: the song's tail on a bar line (unchanged from WP-2.7)."""
    context = fixture.context_audio(WORKING_RATE)
    payload = encode_wav(context)
    params = {
        "context": _base_context(fixture),
        "bars": options.span_bars,
        "overlapBars": OVERLAP_BARS,
        "direction": "forward",
        "tier": _TIER,
        "n": options.n,
    }
    return _Span(
        params=params,
        payloads={"context": payload},
        analysis=context,
        context_bars=fixture.context_bars,
        context_sec=fixture.context_sec,
    )


def _inpaint_span(fixture: Fixture, options: BenchOptions) -> _Span:
    """A four-bar gap cut mid-song, with ~15 s of context on each side."""
    song = fixture.render(WORKING_RATE)
    bar = max(1, round(fixture.bar_sec * WORKING_RATE))
    gap_bars = options.span_bars
    gap_start = max(1, (fixture.bars - gap_bars) // 2)
    context_bars = max(2, round(FILL_CONTEXT_TARGET_SEC / fixture.bar_sec))
    context_bars = min(context_bars, gap_start, fixture.bars - gap_start - gap_bars)
    before = _slice(song, (gap_start - context_bars) * bar, gap_start * bar)
    after = _slice(song, (gap_start + gap_bars) * bar, (gap_start + gap_bars + context_bars) * bar)
    params = {
        "context": _base_context(fixture),
        "gapBars": gap_bars,
        "overlapBars": FILL_OVERLAP_BARS,
        "tier": _TIER,
        "n": options.n,
    }
    return _Span(
        params=params,
        payloads={"before": encode_wav(before), "after": encode_wav(after)},
        analysis=before,
        context_bars=context_bars,
        context_sec=before.duration_sec,
        gap_start_bar=gap_start,
        before=before,
        after=after,
    )


def _transition_span(fixture: Fixture, options: BenchOptions) -> _Span:
    """The 2 bars across a mid-song bar line: end of A | start of B."""
    song = fixture.render(WORKING_RATE)
    bar = max(1, round(fixture.bar_sec * WORKING_RATE))
    boundary = fixture.bars // 2
    context_bars = min(TRANSITION_CONTEXT_BARS, boundary, fixture.bars - boundary)
    before = _slice(song, (boundary - context_bars) * bar, boundary * bar)
    after = _slice(song, boundary * bar, (boundary + context_bars) * bar)
    params = {
        "context": _base_context(fixture),
        "lengthBars": options.span_bars,
        "tier": _TIER,
        "n": options.n,
    }
    return _Span(
        params=params,
        payloads={"before": encode_wav(before), "after": encode_wav(after)},
        analysis=before,
        context_bars=context_bars,
        context_sec=before.duration_sec,
        boundary_bar=boundary,
        before=before,
        after=after,
    )


def _slice(audio: Audio, start: int, end: int) -> Audio:
    """Frames ``[start, end)`` of a rendered fixture, clamped to its length."""
    begin = max(0, min(start, audio.frames))
    stop = max(begin, min(end, audio.frames))
    return Audio(
        np.ascontiguousarray(audio.samples[begin:stop], dtype=np.float32), audio.sample_rate
    )


def _job(fixture: Fixture, options: BenchOptions, span: _Span) -> JobRequest:
    """The job envelope of 05 §4.2, with the rendered context(s) as its inputs."""
    assets = {
        name: "sha256:" + hashlib.sha256(payload).hexdigest()
        for name, payload in span.payloads.items()
    }
    bars = options.span_bars
    return JobRequest(
        schemaVersion=JobRequestSchemaVersion.integer_1,
        jobId=f"job_01BENCH{fixture.id.upper().replace('-', '')}{options.capability.upper()}",
        capability=CAPABILITY_NAMES[options.capability],
        priority=JobPriority.interactive,
        userId="user_bench",
        inputs=JobInputs(
            assets=assets,
            params=FreeformParams.model_validate(span.params),
        ),
        idempotencyKey=f"bench-{fixture.id}-{options.capability}-{bars}-{options.n}",
        attempt=0,
        deadline="2026-10-21T00:00:00.000Z",
        traceparent="00-11111111111111111111111111111111-2222222222222222-01",
        createdAt="2026-10-21T00:00:00.000Z",
    )


@contextmanager
def _capture_gates(module: ModuleType, runs: list[_GateRun]) -> Iterator[None]:
    """Records every gate pass and its duration.

    ``run_gates`` is each capability's documented seam for tests (09 §6): wrapping it
    changes nothing about the run, it only makes failed attempts visible to the
    report (a rejected attempt is never published as a partial). Extend takes
    ``(candidate, context, request)``, a fill ``(candidate, before, after, request)``,
    so the wrapper forwards whatever it is given.
    """
    original = module.run_gates

    def recording(*args: object) -> GateResult | FillGateResult:
        started = time.perf_counter()
        result = cast(GateResult | FillGateResult, original(*args))
        runs.append(_GateRun(result, time.perf_counter() - started))
        return result

    module.run_gates = recording  # type: ignore[attr-defined]
    try:
        yield
    finally:
        module.run_gates = original  # type: ignore[attr-defined]


def _attempts(runs: Sequence[_GateRun], n: int) -> list[AttemptReport]:
    """Per-attempt rows, with the round and seed the capability derived.

    The loop is deterministic (09 §6, now ``capabilities/streaming``): round 0 asks
    for ``n`` candidates, every later round only for the missing ones, and the seed
    is ``base + round * 16 + slot``. Replaying that here keeps the report honest
    without adding a hook to the capability.
    """
    rows: list[AttemptReport] = []
    accepted = 0
    round_index = 0
    slot = 0
    missing = n
    for run in runs:
        seed = streaming.seed_for(BASE_SEED, round_index, slot)
        rows.append(_attempt_report(run, round_index, seed))
        if run.result.passed:
            accepted += 1
        slot += 1
        if slot >= missing:
            round_index += 1
            slot = 0
            missing = n - accepted
    return rows


def _attempt_report(run: _GateRun, round_index: int, seed: int) -> AttemptReport:
    """One attempt's gate verdicts and metrics."""
    result = run.result
    failed = next(
        (verdict for verdict in result.steps if not verdict.passed and not verdict.skipped), None
    )
    key = result.key_match
    return AttemptReport(
        round=round_index,
        seed=seed,
        passed=result.passed,
        failed_step=failed.step if failed is not None else None,
        reason=failed.reason if failed is not None else None,
        seam_score=_finite(result.seam_score),
        end_seam_score=_end_score(result),
        tempo_error=_finite(result.tempo_error),
        key_detected=key.detected.label if key is not None else None,
        key_relation=key.relation if key is not None else None,
        key_confidence=round(key.confidence, 3) if key is not None else None,
        alignment_confidence=_metric(result, "beat_align", "confidence"),
        steps=_statuses(result),
        gate_sec=round(run.seconds, 3),
    )


def _statuses(result: GateResult | FillGateResult) -> dict[str, Literal["pass", "fail", "skipped"]]:
    """Every gate's verdict as ``pass``/``fail``/``skipped``, in 09 §6 order."""
    by_name = {verdict.step: verdict for verdict in result.steps}
    statuses: dict[str, Literal["pass", "fail", "skipped"]] = {}
    for step in STEP_NAMES:
        verdict = by_name.get(step)
        if verdict is None or verdict.skipped:
            statuses[step] = "skipped"
        else:
            statuses[step] = "pass" if verdict.passed else "fail"
    return statuses


def _candidates(
    outputs: JobOutputs,
    ctx: BenchContext,
    attempts: Sequence[AttemptReport],
    capability: str,
) -> list[CandidateReport]:
    """The candidates the job returned, read from their result blobs."""
    rounds = {attempt.seed: attempt.round for attempt in attempts}
    rows: list[CandidateReport] = []
    blobs = outputs.blobs or {}
    assets = outputs.assets or {}
    for name, blob_hash in blobs.items():
        data = ctx.uploads.get(blob_hash)
        if data is None:
            raise RuntimeError(f"result blob {blob_hash} was not uploaded")
        result: GenerateExtendResult | GenerateFillResult
        if capability == "extend":
            result = GenerateExtendResult.model_validate_json(data)
            start_offset = result.spliceOffsetSamples
            end_offset = None
            end_score = None
        else:
            fill_result = GenerateFillResult.model_validate_json(data)
            result = fill_result
            start_offset = fill_result.startOffsetSamples
            end_offset = fill_result.endOffsetSamples
            end_score = (
                _finite(fill_result.endSeamScore) if fill_result.endSeamScore is not None else None
            )
        asset = assets.get(name) or result.asset
        key = result.keyMatch
        rows.append(
            CandidateReport(
                index=result.index,
                seed=result.seed,
                round=rounds.get(result.seed, 0),
                passed=result.passed,
                quality_warning=result.qualityWarning,
                seam_score=_finite(result.seamScore) if result.seamScore is not None else None,
                end_seam_score=end_score,
                tempo_error=_finite(result.tempoError) if result.tempoError is not None else None,
                key_detected=key.detected.tonic + " " + key.detected.mode
                if key is not None
                else None,
                key_relation=key.relation.value if key is not None else None,
                key_confidence=round(key.confidence, 3) if key is not None else None,
                alignment_confidence=_blob_metric(result, "beat_align", "confidence"),
                start_offset_samples=start_offset,
                end_offset_samples=end_offset,
                asset=asset,
                blob=blob_hash,
            )
        )
    return rows


def _metric(result: GateResult | FillGateResult, step: str, name: str) -> float | None:
    """A numeric metric from one gate verdict."""
    for verdict in result.steps:
        if verdict.step == step:
            value = verdict.metrics.get(name)
            if isinstance(value, int | float) and not isinstance(value, bool):
                return _finite(float(value))
    return None


def _blob_metric(
    result: GenerateExtendResult | GenerateFillResult, step: str, name: str
) -> float | None:
    """The same, from a result blob's step metrics."""
    for verdict in result.steps:
        if verdict.step == step:
            value = verdict.metrics.get(name)
            if isinstance(value, int | float) and not isinstance(value, bool):
                return _finite(float(value))
    return None


def _end_score(result: GateResult | FillGateResult) -> float | None:
    """The end seam score of a fill; ``None`` for an extend."""
    if isinstance(result, FillGateResult):
        return _finite(result.end_seam_score)
    return None


def _finite(value: float) -> float | None:
    """``None`` for an infinite/NaN metric (JSON has no such numbers)."""
    return round(value, 4) if math.isfinite(value) else None


def _kept_audio(
    ctx: BenchContext,
    candidates: Sequence[CandidateReport],
    span: _Span,
    fixture: Fixture,
) -> list[_KeptAudio]:
    """Decodes the returned candidates and joins them for listening."""
    fade = _crossfade_samples(fixture.bpm, WORKING_RATE)
    kept: list[_KeptAudio] = []
    for candidate in candidates:
        if candidate.asset is None:
            continue
        payload = ctx.uploads.get(candidate.asset)
        if payload is None:
            raise RuntimeError(f"candidate audio {candidate.asset} was not uploaded")
        processed = decode(payload)
        kept.append(
            _KeptAudio(
                fixture=fixture.id,
                candidate_index=candidate.index,
                seed=candidate.seed,
                candidate=processed,
                splice=(
                    _splice_preview(span.analysis, processed, candidate, fade)
                    if span.before is None
                    else _fill_preview(span, processed, candidate)
                ),
            )
        )
    return kept


def _crossfade_samples(bpm: float, rate: int) -> int:
    """The gate's crossfade length in samples: one beat, capped at 500 ms (03 §8.2)."""
    cfg = GateConfig.load()
    return max(1, round(min(cfg.crossfade_beats * 60.0 / bpm, cfg.crossfade_max_sec) * rate))


def _splice_preview(
    context: Audio, processed: Audio, candidate: CandidateReport, fade: int
) -> Audio:
    """Context, then the candidate, joined the way the accepted section will play.

    E1's ``extend_placement`` starts the new section at the song end and sets the
    clip's ``srcStart`` to ``-spliceOffset``, so the app skips the part of the
    processed audio that lies *before* the context edge and crossfades the old tail
    into the clip over the gate's crossfade length at the section boundary
    (02 §3.5). The gate's own scoring render sits at the splice point inside the
    overlap and is not what the user hears, so the preview reconstructs the section
    boundary instead. A candidate that never reached the splice gate has offset 0,
    which is the placement it would get as the best rejected one.
    """
    rate = context.sample_rate
    skip = max(0, -candidate.start_offset_samples)
    new = processed.samples[skip:] if processed.frames > skip else processed.samples[:0]
    if context.frames < fade or new.shape[0] < fade:
        preview = np.concatenate([context.samples, new])
    else:
        fade_out, fade_in = seam.crossfade_shape(fade)
        mixed = context.samples[-fade:] * fade_out[:, None] + new[:fade] * fade_in[:, None]
        preview = np.concatenate([context.samples[:-fade], mixed, new[fade:]])
    return Audio(np.ascontiguousarray(preview, dtype=np.float32), rate)


def _fill_preview(span: _Span, processed: Audio, candidate: CandidateReport) -> Audio:
    """The song around the span: context, the processed clip, the remaining context.

    The clip's start offset is relative to the join (the before context's end) and
    its end offset to the gap end (the after context's start), exactly as placement
    reads them. The clip already carries the gate's fade-in and fade-out, so the
    preview concatenates the context before the clip, the clip, and the context from
    where the clip ends; nothing else is crossfaded here.
    """
    before, after = span.before, span.after
    if before is None or after is None:
        raise RuntimeError("a fill preview needs both contexts")
    rate = before.sample_rate
    before_end = max(0, min(before.frames + candidate.start_offset_samples, before.frames))
    after_start = max(0, min(candidate.end_offset_samples or 0, after.frames))
    preview = np.concatenate(
        [before.samples[:before_end], processed.samples, after.samples[after_start:]], axis=0
    )
    return Audio(np.ascontiguousarray(preview, dtype=np.float32), rate)


def _keep_audio(
    fixtures: Sequence[Fixture],
    reports: Sequence[FixtureReport],
    kept: Sequence[_KeptAudio],
    audio_dir: Path,
    capability: str,
) -> list[tuple[str, FixtureReport, CandidateReport]]:
    """Writes sources, candidates and blind splice previews; returns label → candidate."""
    sources = audio_dir / "sources"
    candidates = audio_dir / "candidates"
    splices = audio_dir / "splices"
    for directory in (sources, candidates, splices):
        directory.mkdir(parents=True, exist_ok=True)
    by_fixture = {report.id: report for report in reports}
    # Extend's WP-2.7 paths stay as they are (the 2.7 sheet points at them); a fill
    # prefixes its files so the two capabilities can share one output directory.
    prefix = "" if capability == "extend" else f"{capability}-"
    for fixture in fixtures:
        _write_wav(sources / f"{fixture.id}.wav", fixture.render(WORKING_RATE))
    for audio in kept:
        name = f"{prefix}{audio.fixture}-c{audio.candidate_index}-seed{audio.seed}"
        path = candidates / f"{name}.wav"
        _write_wav(path, audio.candidate)
        candidate = _candidate_of(by_fixture[audio.fixture], audio.candidate_index)
        candidate.candidate_wav = str(path)
    order = list(kept)
    # Fixed seed so the sheet is reproducible; this is a shuffle, not cryptography.
    random.Random(BASE_SEED).shuffle(order)  # noqa: S311
    listening: list[tuple[str, FixtureReport, CandidateReport]] = []
    for position, audio in enumerate(order):
        label = _label(position)
        path = splices / f"{prefix}{label}.wav"
        _write_wav(path, audio.splice)
        candidate = _candidate_of(by_fixture[audio.fixture], audio.candidate_index)
        candidate.splice_wav = str(path)
        listening.append((label, by_fixture[audio.fixture], candidate))
    return listening


def _candidate_of(report: FixtureReport, index: int) -> CandidateReport:
    """The candidate with that index inside a fixture's report."""
    for candidate in report.candidates:
        if candidate.index == index:
            return candidate
    raise KeyError(f"{report.id}: no candidate {index}")


def _label(position: int) -> str:
    """A..Z, AA.. for a long listening sheet."""
    letters = ""
    value = position
    while True:
        letters = chr(ord("A") + value % 26) + letters
        value = value // 26 - 1
        if value < 0:
            return letters


def _write_wav(path: Path, audio: Audio) -> None:
    """Writes 24-bit WAV, the format the audition bar plays."""
    sf.write(path, audio.samples, audio.sample_rate, subtype="PCM_24")


def _write_listening_order(
    listening: Sequence[tuple[str, FixtureReport, CandidateReport]],
    audio_dir: Path,
    capability: str,
) -> None:
    """Writes the blind label → source mapping next to the previews."""
    prefix = "" if capability == "extend" else f"{capability}-"
    name = (
        "listening-order.json" if capability == "extend" else f"listening-order-{capability}.json"
    )
    document = {
        "note": (
            f"Blind listening order for docs/wp/2.8-MANUAL_CHECKS.md; do not open before "
            f"rating. Capability: {capability}."
        ),
        "entries": [
            {
                "label": label,
                "file": f"splices/{prefix}{label}.wav",
                "capability": capability,
                "fixture": report.id,
                "candidate": candidate.index,
                "seed": candidate.seed,
            }
            for label, report, candidate in listening
        ],
    }
    (audio_dir / name).write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")


def _write_report(report: BenchReport, out: Path) -> Path:
    """Writes the JSON report and returns its path."""
    if report.results_path is None:
        raise ValueError("the report has no path")
    path = Path(report.results_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report.model_dump(mode="json"), indent=2) + "\n", encoding="utf-8")
    return path


def _serve_pid_file() -> Path:
    """ACE-Step's ``serve.pid`` next to the checkout, as ``scripts/ace-step-serve.sh`` writes it."""
    for parent in Path(__file__).resolve().parents:
        candidate = parent / ".bragi" / "ace-step" / "serve.pid"
        if candidate.is_file():
            return candidate
    return Path(".bragi/ace-step/serve.pid")


def _print_summary(
    report: BenchReport, listening: Sequence[tuple[str, FixtureReport, CandidateReport]]
) -> None:
    """Prints the per-attempt table and the 09 §9 aggregates."""
    span = _span_label(report)
    print(
        f"\ngenerate bench · {report.capability} · {report.backend} · {report.n} candidates · "
        f"{report.bars} bars{span} · preview · {len(report.fixtures)} song(s)"
    )
    print(f"machine: {report.machine} · {TIMING_LABEL}")
    fill = report.capability != "extend"
    end_header = f"  {'END SEAM':>8s}" if fill else ""
    header = (
        f"{'FIXTURE':8s}  {'#':>2s}  {'RND':>3s}  {'SEED':>10s}  {'PASS':4s}  "
        f"{'FAILED STEP':12s}  {'SEAM':>6s}{end_header}  {'TEMPO':>7s}  {'KEY':28s}  "
        f"{'ALIGN':>5s}  {'GATE S':>6s}"
    )
    print(header)
    print("-" * len(header))
    for fixture in report.fixtures:
        for position, attempt in enumerate(fixture.attempts, start=1):
            key = (
                f"{attempt.key_detected or '-':14s} "
                f"{_relation(attempt.key_relation):10s} {_confidence(attempt.key_confidence)}"
            )
            end = f"  {_number(attempt.end_seam_score, 3):>8s}" if fill else ""
            print(
                f"{fixture.id:8s}  {position:2d}  {attempt.round:3d}  {attempt.seed:10d}  "
                f"{'yes' if attempt.passed else 'no':4s}  "
                f"{(attempt.failed_step or '-'):12s}  "
                f"{_number(attempt.seam_score, 3):>6s}{end}  "
                f"{_percent(attempt.tempo_error):>7s}  {key}  "
                f"{_number(attempt.alignment_confidence, 2):>5s}  "
                f"{attempt.gate_sec:6.2f}"
            )

    print("\nsongs")
    for fixture in report.fixtures:
        print(
            f"  {fixture.id:8s} {fixture.passing}/{len(fixture.candidates)} pass · "
            f"{fixture.regeneration_rounds} regen round(s) · "
            f"first pass {_seconds(fixture.time_to_first_pass_sec)} · "
            f"total {fixture.total_sec:.1f} s · gpu {_seconds(fixture.gpu_seconds)} · "
            f"contexts {fixture.context_bars} bars / {fixture.context_sec:.1f} s "
            f"read as {_number(fixture.detected_context_tempo_bpm, 1)} BPM "
            f"({_tempo_multiple(fixture.detected_context_tempo_bpm, fixture.bpm)}x) "
            f"{fixture.detected_context_key} "
            f"(wrote {fixture.key_requested}, {fixture.bpm:.0f} BPM)"
        )

    aggregates = report.aggregates
    print("\nacceptance")
    print(
        f"  {report.capability} (2 of 3 pass, 4 of 5 songs)  "
        f"{aggregates.check1}  ({aggregates.check1_detail})"
    )
    if not fill:
        print(
            "  check 4 (first preview P50 <= 15 s)  "
            f"NOT MEASURED  ({TIMING_LABEL}; the reference GPU is the reference)"
        )
    print("\ngate pass rate (of every attempt)")
    for rate in aggregates.step_rates:
        print(
            f"  {rate.step:12s} {_ratio(rate.rate):>6s}  "
            f"pass {rate.passed:2d} · fail {rate.failed:2d} · skip {rate.skipped:2d}"
        )

    print("\nseam score (lower is better, 03 §8.2)")
    print(f"  passing candidates, start  {_distribution(aggregates.seam_passing)}")
    print(f"  every scored attempt, start {_distribution(aggregates.seam_scored)}")
    if aggregates.end_seam_passing is not None:
        print(f"  passing candidates, end    {_distribution(aggregates.end_seam_passing)}")
    if aggregates.end_seam_scored is not None:
        print(f"  every scored attempt, end  {_distribution(aggregates.end_seam_scored)}")
    timings = aggregates.time_to_first_pass
    print(
        f"\ntime to first passing candidate  P50 {_seconds(timings.p50)} "
        f"· min {_seconds(timings.min)} · max {_seconds(timings.max)} "
        f"· n={timings.count}  ({TIMING_LABEL})"
    )
    print(
        f"run  {aggregates.total_sec:.1f} s · {aggregates.attempts} attempt(s) · "
        f"{aggregates.regeneration_rounds} regen round(s) · "
        f"peak process {_megabytes(aggregates.peak_process_mb)} · "
        f"peak server {_megabytes(aggregates.peak_server_mb)}"
    )
    if listening:
        print(f"\nkept audio: {report.audio_dir} ({len(listening)} blind preview(s))")
    if report.results_path is not None:
        print(f"report: {report.results_path}")


def _span_label(report: BenchReport) -> str:
    """``(gap)`` / ``(bridge)`` after the capability's main number."""
    if report.capability == "inpaint":
        return " (gap)"
    if report.capability == "transition":
        return " (bridge)"
    return ""


def _tempo_multiple(detected: float | None, requested: float) -> str:
    """How the context's tracked tempo relates to the written one (0.5x, 1x, 2x)."""
    if detected is None or requested <= 0.0:
        return "-"
    return f"{detected / requested:.2f}"


def _relation(relation: str | None) -> str:
    """``relative`` → ``(relative)``; ``-`` when the key gate did not run."""
    return f"({relation})" if relation is not None else "-"


def _confidence(value: float | None) -> str:
    """A 0..1 confidence, or ``-``."""
    return "-" if value is None else f"{value:.2f}"


def _number(value: float | None, digits: int) -> str:
    """A fixed-point number, or ``-``."""
    return "-" if value is None else f"{value:.{digits}f}"


def _percent(value: float | None) -> str:
    """A relative error as a percentage, or ``-``."""
    return "-" if value is None else f"{value * 100.0:.2f}%"


def _seconds(value: float | None) -> str:
    """A duration in seconds, or ``not measured``."""
    return "not measured" if value is None else f"{value:.1f} s"


def _megabytes(value: float | None) -> str:
    """A memory figure in MB or GB, or ``not measured``."""
    if value is None:
        return "not measured"
    return f"{value / 1024.0:.1f} GB" if value >= 1024.0 else f"{value:.0f} MB"


def _ratio(value: float) -> str:
    """A 0..1 ratio as a percentage."""
    return f"{value * 100.0:.0f}%"


def _distribution(stats: SeamStats) -> str:
    """A seam distribution as one line."""
    if stats.count == 0:
        return "no scored candidate"
    return (
        f"n={stats.count} · min {_number(stats.min, 3)} · P25 {_number(stats.p25, 3)} · "
        f"P50 {_number(stats.p50, 3)} · P75 {_number(stats.p75, 3)} · max {_number(stats.max, 3)}"
    )


def _repo_root() -> Path:
    """The repository root: the first parent holding the generation routing table."""
    for parent in Path(__file__).resolve().parents:
        if (parent / "config" / "generation_routes.yaml").is_file():
            return parent
    return Path.cwd()


def parse_args(argv: Sequence[str] | None = None) -> BenchOptions:
    """Parses the command line.

    Raises:
        SystemExit: on ``--help`` or an invalid option (argparse' contract).
    """
    parser = argparse.ArgumentParser(
        prog="python -m bragi_generate.bench",
        description=(
            "Generation bench: 5 fixture songs through generate.extend (09 §9 check 1), "
            "generate.inpaint or generate.transition."
        ),
    )
    parser.add_argument(
        "--capability",
        choices=sorted(CAPABILITY_NAMES),
        default="extend",
        help="capability to run (default extend)",
    )
    parser.add_argument(
        "--backend",
        choices=sorted(routing.BACKEND_FACTORIES),
        default=None,
        help="backend to force; default: the route in config/generation_routes.yaml",
    )
    parser.add_argument(
        "--fixtures", default=None, help="comma-separated fixture ids or globs (default: all)"
    )
    parser.add_argument("--n", type=int, default=3, help="candidates per song (default 3)")
    parser.add_argument(
        "--bars",
        type=int,
        default=None,
        help="bars of new audio / gap / bridge (default: extend 8, inpaint 4, transition 2)",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=_repo_root() / RESULTS_DIR,
        help=f"output directory (default {RESULTS_DIR}/ in the repository root)",
    )
    parser.add_argument(
        "--keep-audio",
        action="store_true",
        help="write the processed candidates, splice previews and sources for listening",
    )
    parser.add_argument("--quiet", action="store_true", help="write the report but print nothing")
    args = parser.parse_args(argv)
    if args.n < 1:
        parser.error("--n must be >= 1")
    if args.bars is not None and args.bars < 1:
        parser.error("--bars must be >= 1")
    capability = args.capability
    backend = args.backend or routing.backend_name(CAPABILITY_NAMES[capability], _TIER)
    # ``uv run --directory`` changes the process's working directory, so a relative
    # --out means "next to the repository root", like the default.
    out = args.out if args.out.is_absolute() else _repo_root() / args.out
    return BenchOptions(
        backend=backend,
        capability=capability,
        fixtures=args.fixtures,
        n=args.n,
        bars=None if args.bars is None else int(args.bars),
        out=out,
        keep_audio=bool(args.keep_audio),
        quiet=bool(args.quiet),
    )


def main(argv: Sequence[str] | None = None) -> int:
    """Runs the bench and exits non-zero only when the harness itself failed."""
    try:
        options = parse_args(argv)
        if (
            options.n < CHECK1_CANDIDATES
            or len(bench_fixtures.select(options.fixtures)) < CHECK1_SONGS
        ):
            print(
                f"note: the fill check needs {CHECK1_SONGS} songs at n >= {CHECK1_CANDIDATES}; "
                "a smaller run is PENDING by design",
                file=sys.stderr,
            )
        run_bench(options)
    except (OSError, KeyError) as failure:
        print(f"[bench:generate] {failure}", file=sys.stderr)
        return 1
    return 0


__all__ = ["BASE_SEED", "BenchOptions", "main", "parse_args", "run_bench"]
