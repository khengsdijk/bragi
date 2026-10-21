"""The generation bench behind ``pnpm bench:generate`` (09 §9 check 1).

For each fixture song it renders the last ~30 s as a 48 kHz WAV, builds the
``generate.extend`` job the API would submit (preview, forward, ``bars`` of new
audio), and runs it **through the capability the worker runs** — routing →
backend → the seven gates → regeneration rounds — with a local
:class:`~bragi_generate.bench.context.BenchContext` instead of NATS/S3. The report
records every attempt and candidate, the 09 §9 check-1 verdict, the per-step gate
pass rate, the seam distribution and the time to the first passing candidate.

The model is whatever the route selects; ``--backend fake`` forces the synthetic
backend for a fast smoke test. With ``--keep-audio`` the processed candidates and a
context+candidate splice preview land in ``bench-results/`` for the owner's blind
listening sheet (``docs/wp/2.7-MANUAL_CHECKS.md``).
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
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, cast

import numpy as np
import soundfile as sf

from bragi_common.context import JobContext
from bragi_common.generated.models import (
    FreeformParams,
    GenerateExtendResult,
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
from bragi_generate.capabilities import extend
from bragi_generate.postprocess import Audio, GateConfig, GateRequest, GateResult, seam, tonality
from bragi_generate.postprocess import tempo as tempo_step
from bragi_generate.postprocess.pipeline import STEP_NAMES
from bragi_generate.postprocess.types import NOTE_NAMES

#: 09 §6 asks for two bars of overlap; the gate searches the splice inside it.
OVERLAP_BARS = 2
#: The base seed of every job; the capability derives one per attempt from it.
BASE_SEED = 1234
#: Default output directory (git-ignored, like the planner bench's). Resolved against
#: the repository root because ``uv run --directory services/workers`` changes the
#: process's working directory before the module starts.
RESULTS_DIR = Path("bench-results")
#: The bench has no JSON schema of its own; the report is a measurement artifact.
REPORT_VERSION = 1
#: Candidate/attempt rows are printed in this order.
_TIER: Literal["preview"] = "preview"


@dataclass(frozen=True)
class BenchOptions:
    """One run's settings, after the CLI has validated them."""

    backend: str
    fixtures: str | None = None
    n: int = 3
    bars: int = 8
    out: Path = RESULTS_DIR
    keep_audio: bool = False
    quiet: bool = False


@dataclass(frozen=True)
class _GateRun:
    """One gate pass and how long it took."""

    result: GateResult
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
    routed = routing.backend_name(extend.CAPABILITY, _TIER)
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
        listening = _keep_audio(fixtures, reports, kept, audio_dir)

    attempts = [attempt for report in reports for attempt in report.attempts]
    candidates = [candidate for report in reports for candidate in report.candidates]
    passing = [candidate for candidate in candidates if candidate.passed]
    status, detail = check_one(reports, options.n)
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
        n=options.n,
        bars=options.bars,
        base_seed=BASE_SEED,
        started_at=started_at,
        finished_at=now(),
        fixtures=reports,
        aggregates=aggregates,
        results_path=str(out / f"generate-{started_at.replace(':', '-')}-{options.backend}.json"),
        audio_dir=str(audio_dir) if audio_dir is not None else None,
    )
    if audio_dir is not None:
        _write_listening_order(listening, audio_dir)
    _write_report(report, out)
    if not options.quiet:
        _print_summary(report, listening)
    return report


def _run_fixture(fixture: Fixture, options: BenchOptions) -> tuple[FixtureReport, list[_KeptAudio]]:
    """Runs one fixture through ``generate.extend`` and measures it."""
    context = fixture.context_audio(WORKING_RATE)
    payload = encode_wav(context)
    context_hash = "sha256:" + hashlib.sha256(payload).hexdigest()
    params = _params(fixture, options)
    job = _job(fixture, params, context_hash)
    ctx = BenchContext(payload)
    gates: list[_GateRun] = []
    started = time.perf_counter()
    with _capture_gates(gates):
        # The capability is typed against the framework's context; the bench implements
        # the same surface in memory (05 §4.3).
        outputs = asyncio.run(extend.run(job, cast(JobContext, ctx)))
    total_sec = time.perf_counter() - started

    detected_bpm, _beats = tempo_step.beat_times(context)
    detected_key, detected_confidence = tonality.detect(context)
    attempts = _attempts(gates, options.n)
    candidates = _candidates(outputs, ctx, attempts)
    passing = sum(1 for candidate in candidates if candidate.passed)
    first_pass = min((partial.at_sec for partial in ctx.partials), default=None)
    kept = _kept_audio(ctx, candidates, context, fixture) if options.keep_audio else []

    report = FixtureReport(
        id=fixture.id,
        title=fixture.title,
        bpm=fixture.bpm,
        time_signature=list(fixture.time_signature),
        key_requested=fixture.key_label,
        bars=options.bars,
        context_bars=fixture.context_bars,
        context_sec=round(fixture.context_sec, 3),
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


def _params(fixture: Fixture, options: BenchOptions) -> dict[str, object]:
    """The ``generate.extend`` params the API would validate and submit."""
    return {
        "context": {
            "bpm": fixture.bpm,
            "timeSignature": list(fixture.time_signature),
            "key": {"tonic": NOTE_NAMES[fixture.key.tonic_pc], "mode": fixture.key.mode},
            "descriptors": list(fixture.descriptors),
            "seed": BASE_SEED,
        },
        "bars": options.bars,
        "overlapBars": OVERLAP_BARS,
        "direction": "forward",
        "tier": _TIER,
        "n": options.n,
    }


def _job(fixture: Fixture, params: dict[str, object], context_hash: str) -> JobRequest:
    """The job envelope of 05 §4.2, with the fixture context as its only input."""
    return JobRequest(
        schemaVersion=JobRequestSchemaVersion.integer_1,
        jobId=f"job_01BENCH{fixture.id.upper().replace('-', '')}",
        capability=extend.CAPABILITY,
        priority=JobPriority.interactive,
        userId="user_bench",
        inputs=JobInputs(
            assets={"context": context_hash},
            params=FreeformParams.model_validate(params),
        ),
        idempotencyKey=f"bench-{fixture.id}-{params['bars']}-{params['n']}",
        attempt=0,
        deadline="2026-10-21T00:00:00.000Z",
        traceparent="00-11111111111111111111111111111111-2222222222222222-01",
        createdAt="2026-10-21T00:00:00.000Z",
    )


@contextmanager
def _capture_gates(runs: list[_GateRun]) -> Iterator[None]:
    """Records every gate pass and its duration.

    ``run_gates`` is the capability's documented seam for tests (09 §6): wrapping it
    changes nothing about the run, it only makes failed attempts visible to the
    report (a rejected attempt is never published as a partial).
    """
    original = extend.run_gates

    def recording(candidate: Audio, context: Audio, request: GateRequest) -> GateResult:
        started = time.perf_counter()
        result = original(candidate, context, request)
        runs.append(_GateRun(result, time.perf_counter() - started))
        return result

    extend.run_gates = recording
    try:
        yield
    finally:
        extend.run_gates = original


def _attempts(runs: Sequence[_GateRun], n: int) -> list[AttemptReport]:
    """Per-attempt rows, with the round and seed the capability derived.

    The capability's loop is deterministic (09 §6): round 0 asks for ``n``
    candidates, every later round only for the missing ones, and the seed is
    ``base + round * 16 + slot``. Replaying that here keeps the report honest
    without adding a hook to the capability.
    """
    rows: list[AttemptReport] = []
    accepted = 0
    round_index = 0
    slot = 0
    missing = n
    for run in runs:
        seed = (BASE_SEED + round_index * 16 + slot) & 0xFFFFFFFF
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
        tempo_error=_finite(result.tempo_error),
        key_detected=key.detected.label if key is not None else None,
        key_relation=key.relation if key is not None else None,
        key_confidence=round(key.confidence, 3) if key is not None else None,
        alignment_confidence=_metric(result, "beat_align", "confidence"),
        steps=_statuses(result),
        gate_sec=round(run.seconds, 3),
    )


def _statuses(result: GateResult) -> dict[str, Literal["pass", "fail", "skipped"]]:
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
    outputs: JobOutputs, ctx: BenchContext, attempts: Sequence[AttemptReport]
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
        result = GenerateExtendResult.model_validate_json(data)
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
                tempo_error=_finite(result.tempoError) if result.tempoError is not None else None,
                key_detected=key.detected.tonic + " " + key.detected.mode
                if key is not None
                else None,
                key_relation=key.relation.value if key is not None else None,
                key_confidence=round(key.confidence, 3) if key is not None else None,
                alignment_confidence=_blob_metric(result, "beat_align", "confidence"),
                splice_offset_samples=result.spliceOffsetSamples,
                asset=asset,
                blob=blob_hash,
            )
        )
    return rows


def _metric(result: GateResult, step: str, name: str) -> float | None:
    """A numeric metric from one gate verdict."""
    for verdict in result.steps:
        if verdict.step == step:
            value = verdict.metrics.get(name)
            if isinstance(value, int | float) and not isinstance(value, bool):
                return _finite(float(value))
    return None


def _blob_metric(result: GenerateExtendResult, step: str, name: str) -> float | None:
    """The same, from a result blob's step metrics."""
    for verdict in result.steps:
        if verdict.step == step:
            value = verdict.metrics.get(name)
            if isinstance(value, int | float) and not isinstance(value, bool):
                return _finite(float(value))
    return None


def _finite(value: float) -> float | None:
    """``None`` for an infinite/NaN metric (JSON has no such numbers)."""
    return round(value, 4) if math.isfinite(value) else None


def _kept_audio(
    ctx: BenchContext,
    candidates: Sequence[CandidateReport],
    context: Audio,
    fixture: Fixture,
) -> list[_KeptAudio]:
    """Decodes the returned candidates and joins them onto the context for listening."""
    rate = WORKING_RATE
    fade = _crossfade_samples(fixture.bpm, rate)
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
                splice=_splice_preview(context, processed, candidate, fade),
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
    skip = max(0, -candidate.splice_offset_samples)
    new = processed.samples[skip:] if processed.frames > skip else processed.samples[:0]
    if context.frames < fade or new.shape[0] < fade:
        preview = np.concatenate([context.samples, new])
    else:
        fade_out, fade_in = seam.crossfade_shape(fade)
        mixed = context.samples[-fade:] * fade_out[:, None] + new[:fade] * fade_in[:, None]
        preview = np.concatenate([context.samples[:-fade], mixed, new[fade:]])
    return Audio(np.ascontiguousarray(preview, dtype=np.float32), rate)


def _keep_audio(
    fixtures: Sequence[Fixture],
    reports: Sequence[FixtureReport],
    kept: Sequence[_KeptAudio],
    audio_dir: Path,
) -> list[tuple[str, FixtureReport, CandidateReport]]:
    """Writes sources, candidates and blind splice previews; returns label → candidate."""
    sources = audio_dir / "sources"
    candidates = audio_dir / "candidates"
    splices = audio_dir / "splices"
    for directory in (sources, candidates, splices):
        directory.mkdir(parents=True, exist_ok=True)
    by_fixture = {report.id: report for report in reports}
    for fixture in fixtures:
        _write_wav(sources / f"{fixture.id}.wav", fixture.render(WORKING_RATE))
    for audio in kept:
        name = f"{audio.fixture}-c{audio.candidate_index}-seed{audio.seed}"
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
        path = splices / f"{label}.wav"
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
    listening: Sequence[tuple[str, FixtureReport, CandidateReport]], audio_dir: Path
) -> None:
    """Writes the blind label → source mapping next to the previews."""
    document = {
        "note": (
            "Blind listening order for docs/wp/2.7-MANUAL_CHECKS.md; do not open before rating."
        ),
        "entries": [
            {
                "label": label,
                "file": f"splices/{label}.wav",
                "fixture": report.id,
                "candidate": candidate.index,
                "seed": candidate.seed,
            }
            for label, report, candidate in listening
        ],
    }
    (audio_dir / "listening-order.json").write_text(
        json.dumps(document, indent=2) + "\n", encoding="utf-8"
    )


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
    print(
        f"\ngenerate bench · {report.backend} · {report.n} candidates · "
        f"{report.bars} bars · preview · {len(report.fixtures)} song(s)"
    )
    print(f"machine: {report.machine} · {TIMING_LABEL}")
    header = (
        f"{'FIXTURE':8s}  {'#':>2s}  {'RND':>3s}  {'SEED':>10s}  {'PASS':4s}  "
        f"{'FAILED STEP':12s}  {'SEAM':>6s}  {'TEMPO':>7s}  {'KEY':28s}  "
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
            print(
                f"{fixture.id:8s}  {position:2d}  {attempt.round:3d}  {attempt.seed:10d}  "
                f"{'yes' if attempt.passed else 'no':4s}  "
                f"{(attempt.failed_step or '-'):12s}  "
                f"{_number(attempt.seam_score, 3):>6s}  "
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
            f"context {_number(fixture.detected_context_tempo_bpm, 1)} BPM "
            f"({_tempo_multiple(fixture.detected_context_tempo_bpm, fixture.bpm)}x) "
            f"{fixture.detected_context_key} "
            f"(wrote {fixture.key_requested}, {fixture.bpm:.0f} BPM)"
        )

    aggregates = report.aggregates
    print("\n09 §9 acceptance")
    print(
        f"  check 1 (2 of 3 pass, 4 of 5 songs)  {aggregates.check1}  ({aggregates.check1_detail})"
    )
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
    print(f"  passing candidates  {_distribution(aggregates.seam_passing)}")
    print(f"  every scored attempt {_distribution(aggregates.seam_scored)}")
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
        print(f"\nkept audio: {report.audio_dir} ({len(listening)} blind splice preview(s))")
    if report.results_path is not None:
        print(f"report: {report.results_path}")


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
        description="Generation bench: 5 fixture songs through generate.extend (09 §9 check 1).",
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
    parser.add_argument("--bars", type=int, default=8, help="bars of new audio (default 8)")
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
    if args.bars < 1:
        parser.error("--bars must be >= 1")
    backend = args.backend or routing.backend_name(extend.CAPABILITY, _TIER)
    # ``uv run --directory`` changes the process's working directory, so a relative
    # --out means "next to the repository root", like the default.
    out = args.out if args.out.is_absolute() else _repo_root() / args.out
    return BenchOptions(
        backend=backend,
        fixtures=args.fixtures,
        n=args.n,
        bars=args.bars,
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
                f"note: 09 §9 check 1 needs {CHECK1_SONGS} songs at n >= {CHECK1_CANDIDATES}; "
                "a smaller run is PENDING by design",
                file=sys.stderr,
            )
        run_bench(options)
    except (OSError, KeyError) as failure:
        print(f"[bench:generate] {failure}", file=sys.stderr)
        return 1
    return 0


__all__ = ["BASE_SEED", "BenchOptions", "main", "parse_args", "run_bench"]
