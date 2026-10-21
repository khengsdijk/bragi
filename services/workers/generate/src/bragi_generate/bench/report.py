"""The bench report: JSON models, aggregates and the machine label (09 §9).

The shape follows the other benches in the repo: one report per run in
``bench-results/`` (git-ignored), plus the same numbers printed as a table. The
aggregates are the ones the work package asks for — 09 §9 check 1, the per-step
gate pass rate, the seam-score distribution and the time to the first passing
candidate — and a number is only reported when it was measured, never invented.
"""

from __future__ import annotations

import datetime as dt
import math
import os
import platform
import re
import shutil
import subprocess
import sys
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from bragi_generate.postprocess.pipeline import STEP_NAMES

#: Every timing in this bench is measured on the development machine, not the GPU
#: the 09 §5 budget names (check 4 still needs the reference GPU).
TIMING_LABEL = "M2 Pro / MPS, not the reference GPU"
#: Check 1 needs all five songs at three candidates each (09 §9).
CHECK1_SONGS = 5
CHECK1_CANDIDATES = 3
#: Passing candidates one song needs for check 1.
CHECK1_PER_SONG = 2
#: Songs that must meet it.
CHECK1_SONGS_REQUIRED = 4

type GateStatus = Literal["pass", "fail", "skipped"]
type CheckStatus = Literal["PASS", "FAIL", "PENDING"]


class AttemptReport(BaseModel):
    """One generation attempt: the model call plus its seven gate verdicts."""

    model_config = ConfigDict(extra="forbid")

    round: int
    seed: int
    passed: bool
    failed_step: str | None = None
    reason: str | None = None
    seam_score: float | None = None
    tempo_error: float | None = None
    key_detected: str | None = None
    key_relation: str | None = None
    key_confidence: float | None = None
    alignment_confidence: float | None = None
    steps: dict[str, GateStatus]
    gate_sec: float


class CandidateReport(BaseModel):
    """One candidate as the job returned it (a passing one, or the best rejected)."""

    model_config = ConfigDict(extra="forbid")

    index: int
    seed: int
    round: int
    passed: bool
    quality_warning: bool
    seam_score: float | None = None
    tempo_error: float | None = None
    key_detected: str | None = None
    key_relation: str | None = None
    key_confidence: float | None = None
    alignment_confidence: float | None = None
    splice_offset_samples: int
    asset: str | None = None
    blob: str | None = None
    candidate_wav: str | None = None
    splice_wav: str | None = None


class FixtureReport(BaseModel):
    """One fixture song: its facts, every attempt, the returned candidates and timings."""

    model_config = ConfigDict(extra="forbid")

    id: str
    title: str
    bpm: float
    time_signature: list[int]
    key_requested: str
    bars: int
    context_bars: int
    context_sec: float
    detected_context_tempo_bpm: float | None = None
    detected_context_key: str | None = None
    detected_context_key_confidence: float | None = None
    attempts: list[AttemptReport] = Field(default_factory=list)
    candidates: list[CandidateReport] = Field(default_factory=list)
    passing: int = 0
    regeneration_rounds: int = 0
    time_to_first_pass_sec: float | None = None
    total_sec: float
    gpu_seconds: float | None = None
    model: str | None = None
    peak_process_mb: float | None = None


class StepRate(BaseModel):
    """How often one gate let a candidate through, over every attempt."""

    model_config = ConfigDict(extra="forbid")

    step: str
    passed: int
    failed: int
    skipped: int
    attempts: int
    rate: float


class SeamStats(BaseModel):
    """Seam-score distribution (lower is better, 03 §8.2)."""

    model_config = ConfigDict(extra="forbid")

    count: int
    min: float | None = None
    p25: float | None = None
    p50: float | None = None
    p75: float | None = None
    max: float | None = None


class TimingStats(BaseModel):
    """A small distribution of wall-clock times, in seconds."""

    model_config = ConfigDict(extra="forbid")

    count: int
    p50: float | None = None
    min: float | None = None
    max: float | None = None


class AggregateReport(BaseModel):
    """The numbers 09 §9 and the work package ask for, over the whole run."""

    model_config = ConfigDict(extra="forbid")

    fixtures: int
    attempts: int
    candidates: int
    passing_candidates: int
    fixtures_with_two_passing: int
    check1: CheckStatus
    check1_detail: str
    step_rates: list[StepRate]
    seam_passing: SeamStats
    seam_scored: SeamStats
    time_to_first_pass: TimingStats
    regeneration_rounds: int
    total_sec: float
    peak_process_mb: float | None = None
    peak_server_mb: float | None = None


class BenchReport(BaseModel):
    """Everything one ``python -m bragi_generate.bench`` run reports."""

    model_config = ConfigDict(extra="forbid")

    schema_version: Literal[1] = 1
    machine: str
    timing_label: str = TIMING_LABEL
    backend: str
    tier: Literal["preview"] = "preview"
    n: int
    bars: int
    base_seed: int
    started_at: str
    finished_at: str
    fixtures: list[FixtureReport]
    aggregates: AggregateReport
    results_path: str | None = None
    audio_dir: str | None = None


def now() -> str:
    """An RFC 3339 UTC timestamp (02 §2.2)."""
    return dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def machine_label() -> str:
    """The machine the numbers were measured on, e.g. ``macOS 15.6 arm64 · Apple M2 Pro``."""
    parts = [platform.platform(terse=True), platform.machine()]
    brand = _cpu_brand()
    if brand is not None:
        parts.append(brand)
    cores = _cores()
    if cores is not None:
        parts.append(f"{cores} cores")
    return " · ".join(part for part in parts if part)


def _cpu_brand() -> str | None:
    """The CPU's marketing name (macOS ``sysctl``); ``None`` when unavailable."""
    if sys.platform != "darwin":
        return None
    sysctl = shutil.which("sysctl")
    if sysctl is None:
        return None
    try:
        result = subprocess.run(  # noqa: S603 - fixed argv, no user input
            [sysctl, "-n", "machdep.cpu.brand_string"],
            capture_output=True,
            text=True,
            check=False,
            timeout=5,
        )
    except OSError:
        return None
    brand = result.stdout.strip()
    return brand or None


def _cores() -> int | None:
    """Logical CPU count, when the platform reports one."""
    return os.cpu_count()


def process_peak_mb() -> float | None:
    """Peak RSS of the bench process in MB (macOS bytes, Linux KiB), or ``None``."""
    try:
        import resource
    except ImportError:  # pragma: no cover - every supported worker platform has it
        return None
    peak = float(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
    # macOS reports bytes, Linux and the BSDs kibibytes (Python docs).
    megabytes = peak / (1024.0 * 1024.0) if sys.platform == "darwin" else peak / 1024.0
    return round(megabytes, 1)


def server_peak_mb(pid_file: Path) -> float | None:
    """Peak ``phys_footprint`` of an ACE-Step server tree, in MB (macOS only).

    The REST server runs in its own process (``scripts/ace-step-serve.sh`` writes
    the parent's PID), so the bench process's RSS says nothing about model memory.
    ``footprint`` reports the kernel's physical footprint, which is what the MPS
    allocations show up in (A1's 20-22 GB); ``ps`` RSS does not.
    """
    footprint = shutil.which("footprint")
    if footprint is None or sys.platform != "darwin" or not pid_file.is_file():
        return None
    try:
        pid = int(pid_file.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return None
    peaks = [
        peak
        for peak in (_footprint_peak_mb(footprint, process) for process in (pid, *_children(pid)))
        if peak is not None
    ]
    return max(peaks) if peaks else None


def _children(pid: int) -> list[int]:
    """Direct children of a PID (``pgrep -P``), empty when it has none."""
    pgrep = shutil.which("pgrep")
    if pgrep is None:
        return []
    try:
        result = subprocess.run(  # noqa: S603 - fixed argv, no user input
            [pgrep, "-P", str(pid)],
            capture_output=True,
            text=True,
            check=False,
            timeout=5,
        )
    except OSError:
        return []
    children: list[int] = []
    for line in result.stdout.split():
        try:
            children.append(int(line))
        except ValueError:
            continue
    return children


def _footprint_peak_mb(footprint: str, pid: int) -> float | None:
    """One process's ``phys_footprint_peak``, parsed from the ``footprint`` text."""
    try:
        result = subprocess.run(  # noqa: S603 - fixed argv, no user input
            [footprint, "-p", str(pid)],
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )
    except OSError:
        return None
    match = re.search(r"phys_footprint_peak:\s*([0-9.]+)\s*([KMG]B)", result.stdout)
    if match is None:
        return None
    value = float(match.group(1))
    unit = match.group(2)
    factor = {"KB": 1.0 / 1024.0, "MB": 1.0, "GB": 1024.0}[unit]
    return round(value * factor, 1)


def percentile(sorted_values: Sequence[float], fraction: float) -> float | None:
    """Nearest-rank percentile of an already sorted sequence."""
    if not sorted_values:
        return None
    rank = math.ceil(fraction * len(sorted_values)) - 1
    return round(sorted_values[max(0, min(len(sorted_values) - 1, rank))], 3)


def seam_stats(scores: Iterable[float]) -> SeamStats:
    """The seam-score distribution of a set of finite scores."""
    values = sorted(score for score in scores if math.isfinite(score))
    return SeamStats(
        count=len(values),
        min=percentile(values, 0.0),
        p25=percentile(values, 0.25),
        p50=percentile(values, 0.5),
        p75=percentile(values, 0.75),
        max=percentile(values, 1.0),
    )


def timing_stats(seconds: Iterable[float]) -> TimingStats:
    """P50/min/max of a set of durations."""
    values = sorted(seconds)
    return TimingStats(
        count=len(values),
        p50=percentile(values, 0.5),
        min=percentile(values, 0.0),
        max=percentile(values, 1.0),
    )


def step_rates(attempts: Iterable[AttemptReport]) -> list[StepRate]:
    """Per-step pass/fail/skip counts over every attempt."""
    rows: list[StepRate] = []
    collected = list(attempts)
    for step in STEP_NAMES:
        passed = sum(1 for attempt in collected if attempt.steps.get(step) == "pass")
        skipped = sum(1 for attempt in collected if attempt.steps.get(step) == "skipped")
        failed = sum(1 for attempt in collected if attempt.steps.get(step) == "fail")
        total = passed + failed + skipped
        rows.append(
            StepRate(
                step=step,
                passed=passed,
                failed=failed,
                skipped=skipped,
                attempts=total,
                rate=round(passed / total, 4) if total > 0 else 0.0,
            )
        )
    return rows


def check_one(fixtures: Sequence[FixtureReport], n: int) -> tuple[CheckStatus, str]:
    """09 §9 check 1: ≥ 2 of 3 candidates pass for ≥ 4 of 5 songs.

    The verdict is only PASS/FAIL when the run really covered the check (all five
    songs, at least three candidates each); a partial run is PENDING and says why.
    """
    with_two = sum(1 for fixture in fixtures if fixture.passing >= CHECK1_PER_SONG)
    detail = f"{with_two} of {_songs(len(fixtures))} have >= {CHECK1_PER_SONG} passing candidates"
    if len(fixtures) < CHECK1_SONGS or n < CHECK1_CANDIDATES:
        return "PENDING", (
            f"{detail}; check 1 needs {CHECK1_SONGS} songs and n >= {CHECK1_CANDIDATES}, "
            f"this run used {_songs(len(fixtures))} and n = {n}"
        )
    status: CheckStatus = "PASS" if with_two >= CHECK1_SONGS_REQUIRED else "FAIL"
    return status, detail


def _songs(count: int) -> str:
    """``1 song`` / ``5 songs``, for the check-1 sentence."""
    return f"{count} song" if count == 1 else f"{count} songs"


__all__ = [
    "CHECK1_CANDIDATES",
    "CHECK1_PER_SONG",
    "CHECK1_SONGS",
    "CHECK1_SONGS_REQUIRED",
    "TIMING_LABEL",
    "AggregateReport",
    "AttemptReport",
    "BenchReport",
    "CandidateReport",
    "CheckStatus",
    "FixtureReport",
    "GateStatus",
    "SeamStats",
    "StepRate",
    "TimingStats",
    "check_one",
    "machine_label",
    "now",
    "percentile",
    "process_peak_mb",
    "seam_stats",
    "server_peak_mb",
    "step_rates",
    "timing_stats",
]
