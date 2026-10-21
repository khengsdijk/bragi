"""The ``generate.inpaint`` capability (``specs/09-generation.md`` §4.3, §6).

Fills the gap between ``inputs.assets.before`` and ``inputs.assets.after``. Both
contexts end/start on the gap's edges; the backend generates ``overlapBars +
gapBars + overlapBars`` so the gate pass can splice inside each overlap. From there
the shared two-sided path runs: one candidate at a time, both seams gated, passing
candidates streamed as ``partials``, failed ones regenerated for two rounds.

Nothing here touches the song document: the result blob's offsets tell placement
where the span sits (task B).
"""

from __future__ import annotations

from bragi_common.context import JobContext
from bragi_common.generated.models import GenerateInpaintParams, JobOutputs, JobRequest
from bragi_common.protocol import params_of
from bragi_generate.capabilities import fill
from bragi_generate.postprocess import Audio, FillGateRequest, FillGateResult, postprocess_fill

#: Capability name; the NATS subject is ``jobs.generate.inpaint.<priority>`` (05 §4.1).
CAPABILITY = "generate.inpaint"


def run_gates(
    candidate: Audio, before: Audio, after: Audio, request: FillGateRequest
) -> FillGateResult:
    """Runs the two-sided gates of 09 §6. A seam for tests to substitute a verdict."""
    return postprocess_fill(candidate, before, after, request)


async def run(job: JobRequest, ctx: JobContext) -> JobOutputs:
    """Generates and gates up to ``n`` candidates for one inpaint request."""
    params = GenerateInpaintParams.model_validate(params_of(job))
    spec = fill.FillSpec(
        capability=CAPABILITY,
        context=params.context,
        gap_bars=params.gapBars,
        lead_bars=0.0,
        overlap_bars=params.overlapBars or 1,
        tier=params.tier,
        n=params.n,
        seed=params.seed,
        prompt=params.prompt,
    )
    return await fill.run_fill(job, ctx, spec, run_gates)


#: The capability contract's names (13 §3).
ParamsModel = GenerateInpaintParams


__all__ = [
    "CAPABILITY",
    "ParamsModel",
    "run",
    "run_gates",
]
