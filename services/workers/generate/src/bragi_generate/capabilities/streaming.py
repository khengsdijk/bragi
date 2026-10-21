"""The candidate loop every generation capability shares (09 §6, WP-2.8).

``generate.extend``, ``generate.inpaint`` and ``generate.transition`` differ in
their request, their backend call and their gates, but not in how they stream:
call the backend one candidate at a time, gate it, publish a passing candidate as a
``partial`` immediately, regenerate the missing ones with new seeds for up to two
extra rounds, and fall back to the best rejected candidate with ``qualityWarning``
when none pass.

The loop lives here so the capabilities only own the parts that differ. The gate
type is a parameter: extend returns a :class:`~bragi_generate.postprocess.GateResult`
and the two-sided capabilities a
:class:`~bragi_generate.postprocess.FillGateResult`.
"""

from __future__ import annotations

import asyncio
import logging
import math
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, replace

from bragi_common.cancel import JobCancelledError
from bragi_common.context import JobContext
from bragi_common.generated.models import JobMetrics, JobOutputs, JobRequest
from bragi_generate.backend import GenerationBackend, GenOutput

#: 09 §6: the initial round plus two rounds of new seeds.
ROUNDS = 3
#: Seeds are spaced per round so a round never repeats an earlier seed.
SEED_STRIDE = 16
_LOGGER = logging.getLogger("bragi_generate.streaming")


@dataclass(frozen=True)
class Candidate[TGate]:
    """One generated and gated candidate, before or after upload."""

    index: int
    output: GenOutput
    gate: TGate
    asset: str | None = None
    blob: str | None = None


@dataclass(frozen=True)
class Streamed[TGate]:
    """What the loop produced, for the capability's metrics and return value."""

    accepted: tuple[Candidate[TGate], ...]
    attempts: int
    gpu_seconds: float
    last: GenOutput | None


def seed_for(base_seed: int, round_index: int, slot: int) -> int:
    """The seed of one attempt: ``base + round * 16 + slot`` (09 §6)."""
    return (base_seed + round_index * SEED_STRIDE + slot) & 0xFFFFFFFF


async def stream[TGate](
    job: JobRequest,
    ctx: JobContext,
    *,
    capability: str,
    backend: GenerationBackend,
    target: int,
    base_seed: int,
    generate: Callable[[int], tuple[GenOutput, TGate]],
    passed: Callable[[TGate], bool],
    sort_score: Callable[[TGate], float],
    publish: Callable[[Candidate[TGate], bool], Awaitable[Candidate[TGate]]],
    outputs: Callable[[Sequence[Candidate[TGate]]], JobOutputs],
) -> Streamed[TGate]:
    """Generates and gates up to ``target`` candidates, streaming each pass.

    Args:
        job: The job envelope, for cancellation and logging.
        ctx: The framework's context: progress, partials, downloads and metrics.
        capability: The capability name, for the log line.
        backend: The routed backend; only its name is used here.
        target: The requested number of passing candidates.
        base_seed: The request's base seed; every attempt derives its own.
        generate: One attempt, run in a worker thread: seed → (output, gate).
        passed: Whether a gate result counts as a passing candidate.
        sort_score: A gate result's seam score, lower is better; ``inf`` is allowed.
        publish: Uploads a candidate and its blob, returning it with both hashes.
        outputs: Builds the job outputs from the candidates.
    """
    accepted: list[Candidate[TGate]] = []
    failures: list[Candidate[TGate]] = []
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
            seed = seed_for(base_seed, round_index, slot)
            output, gate = await asyncio.to_thread(generate, seed)
            last = output
            total_gpu_sec += output.timings.generate_sec
            attempts += 1

            if passed(gate):
                uploaded = await publish(Candidate(len(accepted), output, gate), False)
                accepted.append(uploaded)
                await ctx.partial(outputs([uploaded]))
            else:
                failures.append(Candidate(-1, output, gate))
            await ctx.progress(_progress(attempts, target), _eta(attempts, target, total_gpu_sec))

    if not accepted:
        if not failures:
            raise RuntimeError("no candidate was produced")
        best = min(failures, key=lambda candidate: _sort_key(candidate, sort_score))
        accepted.append(await publish(replace(best, index=0), True))

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
        "generation done",
        extra={
            "job": job.jobId,
            "capability": capability,
            "backend": backend.name,
            "accepted": len(accepted),
            "attempts": attempts,
            "seconds": round(total_gpu_sec, 2),
        },
    )
    return Streamed(tuple(accepted), attempts, total_gpu_sec, last)


def _sort_key[TGate](
    candidate: Candidate[TGate], sort_score: Callable[[TGate], float]
) -> tuple[float, int]:
    """Best first: a finite score, then the generation order."""
    score = sort_score(candidate.gate)
    return (score if math.isfinite(score) else math.inf, candidate.output.seed)


def _progress(attempts: int, target: int) -> float:
    """Attempt-based progress, capped below 1 until the job really finishes."""
    return min(0.95, 0.05 + 0.90 * attempts / (target * ROUNDS))


def _eta(attempts: int, target: int, seconds: float) -> float | None:
    """A naive remaining-time estimate from the average attempt."""
    if attempts <= 0 or seconds <= 0.0:
        return None
    return round(seconds / attempts * max(1, target * ROUNDS - attempts), 1)


__all__ = ["ROUNDS", "Candidate", "Streamed", "seed_for", "stream"]
