"""The ``generate.transition`` capability (``specs/09-generation.md`` §4.4, §6).

Bridges two sections for "Smooth with AI": ``inputs.assets.before`` is the end of
the outgoing section, ``inputs.assets.after`` the start of the incoming one. The
generated audio is ``lengthBars`` long and centred on the boundary — half replaces
the outgoing tail, half the incoming head — so the shared two-sided path sees a
normal join with a lead on each side.

The accepted candidate becomes ``Transition { kind: "generated", asset,
lengthTicks }`` on the incoming section (02 §3.5, task B).
"""

from __future__ import annotations

from bragi_common.context import JobContext
from bragi_common.generated.models import GenerateTransitionParams, JobOutputs, JobRequest
from bragi_common.protocol import params_of
from bragi_generate.capabilities import fill
from bragi_generate.postprocess import Audio, FillGateRequest, FillGateResult, postprocess_fill

#: Capability name; the NATS subject is ``jobs.generate.transition.<priority>`` (05 §4.1).
CAPABILITY = "generate.transition"
#: Bars of context the model may re-create on each side of the bridge (lead included).
#: Two bars, not one: a four-bar bridge only reaches six bars, and the key reading on
#: a shorter span is unstable (the same finding as the inpaint's overlap default).
TRANSITION_OVERLAP_BARS = 2


def run_gates(
    candidate: Audio, before: Audio, after: Audio, request: FillGateRequest
) -> FillGateResult:
    """Runs the two-sided gates of 09 §6. A seam for tests to substitute a verdict."""
    return postprocess_fill(candidate, before, after, request)


async def run(job: JobRequest, ctx: JobContext) -> JobOutputs:
    """Generates and gates up to ``n`` candidates for one transition request."""
    params = GenerateTransitionParams.model_validate(params_of(job))
    spec = fill.FillSpec(
        capability=CAPABILITY,
        context=params.context,
        gap_bars=0,
        # Half before, half after the boundary (09 §4.4); one bar leads by half.
        lead_bars=params.lengthBars / 2.0,
        overlap_bars=TRANSITION_OVERLAP_BARS,
        tier=params.tier,
        n=params.n,
        seed=params.seed,
        prompt=params.prompt,
    )
    return await fill.run_fill(job, ctx, spec, run_gates)


#: The capability contract's names (13 §3).
ParamsModel = GenerateTransitionParams


__all__ = [
    "CAPABILITY",
    "TRANSITION_OVERLAP_BARS",
    "ParamsModel",
    "run",
    "run_gates",
]
