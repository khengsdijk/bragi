"""The capability contract (``specs/13`` §3).

A capability is a module exposing ``CAPABILITY``, ``ParamsModel`` and
``run(job, ctx) -> Outputs``. The framework owns pulling, caching, IO, progress
and cancellation; the capability only computes.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Protocol

from pydantic import BaseModel

from bragi_common.context import JobContext
from bragi_common.generated.models import JobOutputs, JobRequest

#: A capability's result (the ``Outputs`` of 13 §3).
Outputs = JobOutputs

#: Signature of the partial-output sender the framework hands to a context.
PartialSender = Callable[[Outputs], Awaitable[None]]


class Capability(Protocol):
    """Structural type of a capability module."""

    @property
    def CAPABILITY(self) -> str:  # noqa: N802 - the contract's own name (13 §3)
        """The capability name, e.g. ``echo`` (05 §4.1)."""
        ...

    @property
    def ParamsModel(self) -> type[BaseModel]:  # noqa: N802 - the contract's own name
        """The params schema validated before :func:`run`."""
        ...

    @property
    def run(self) -> Callable[[JobRequest, JobContext], Awaitable[Outputs]]:
        """Executes the job and returns its outputs."""
        ...


def params_of(job: JobRequest) -> dict[str, object]:
    """The job's params as a plain dict.

    ``JobInputs.params`` is the generated ``FreeformParams`` model, which a
    capability's own ``ParamsModel`` cannot validate directly; this flattens it
    once so every capability validates the same shape.
    """
    return dict(job.inputs.params.model_dump(mode="json"))


__all__ = ["Capability", "Outputs", "PartialSender", "params_of"]
