"""The ``describe`` capability (``specs/04`` §6.3).

Reads the analysis blobs the orchestrator passes (``structure``, ``loudness_energy``, ``harmony``,
``rhythm``, ``tag``, ``stem_activity``; any may be absent), builds the feature digest, asks Claude
for the description through the ``DescribeClient`` seam, runs the grounding post-check, and
publishes a ``DescriptionResult`` blob under ``describe``.

Input: ``blobs.*`` only (no audio is read). Output: ``blobs.describe`` (a ``DescriptionResult``).
A missing API key, or a description the post-check cannot ground, fails the stage with a clear
reason (Q72). Nothing is substituted with generic text.
"""

from __future__ import annotations

import logging
from collections.abc import Callable

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from bragi_analysis.describe import features as feature_builder
from bragi_analysis.describe import pipeline
from bragi_analysis.describe.grounding import GroundingRejectedError
from bragi_analysis.describe.llm import (
    AnthropicClient,
    DescribeClient,
    DescribeUnavailableError,
)
from bragi_analysis.describe.pipeline import DescriptionInvalidError
from bragi_analysis.describe.prompt import PROMPT_VERSION
from bragi_analysis.describe.settings import load as load_config
from bragi_analysis.describe.settings import resolve_model
from bragi_common.cancel import JobCancelledError
from bragi_common.context import JobContext
from bragi_common.generated.models import (
    HarmonyResult,
    JobOutputs,
    JobRequest,
    LoudnessEnergyResult,
    RhythmResult,
    StemActivityResult,
    StructureResult,
    TagResult,
)
from bragi_common.protocol import params_of

CAPABILITY = "analysis.describe"

_logger = logging.getLogger("bragi_analysis.describe")

#: Builds the client. Tests replace this with a fake; production uses the environment key.
client_factory: Callable[[], DescribeClient] = AnthropicClient.from_env


class ParamsModel(BaseModel):
    """Parameters for ``describe``."""

    model_config = ConfigDict(extra="forbid")

    #: Overrides the configured model ID for this job (``config/describe.toml``).
    model: str | None = Field(default=None, min_length=1)


async def run(job: JobRequest, ctx: JobContext) -> JobOutputs:
    """Describes the song from its analysis blobs and publishes a ``DescriptionResult``."""
    params = ParamsModel.model_validate(params_of(job))
    config = load_config()
    model = resolve_model(config, params.model)

    blobs = job.inputs.blobs or {}
    if not blobs:
        raise ValueError("describe needs at least one analysis blob (structure, tag, harmony, ...)")

    structure = await _load(ctx, blobs, "structure", StructureResult)
    loudness = await _load(ctx, blobs, "loudness_energy", LoudnessEnergyResult)
    harmony = await _load(ctx, blobs, "harmony", HarmonyResult)
    rhythm = await _load(ctx, blobs, "rhythm", RhythmResult)
    tags = await _load(ctx, blobs, "tag", TagResult)
    stems = await _load(ctx, blobs, "stem_activity", StemActivityResult)
    await ctx.progress(0.2)

    features = feature_builder.build(
        structure=structure,
        loudness=loudness,
        harmony=harmony,
        rhythm=rhythm,
        tags=tags,
        stems=stems,
    )

    try:
        client = client_factory()
    except DescribeUnavailableError as exc:
        raise ValueError(str(exc)) from None
    if await ctx.cancelled():
        raise JobCancelledError(f"job {job.jobId} cancelled")

    try:
        outcome = await pipeline.describe(
            features,
            client,
            model=model,
            max_tokens=config.max_tokens,
            blocked_terms=config.blocked_terms,
        )
    except DescriptionInvalidError as exc:
        raise ValueError(f"the model's description was not valid JSON: {exc}") from None
    except GroundingRejectedError as exc:
        raise ValueError(f"the description could not be grounded in the analysis: {exc}") from None
    await ctx.progress(0.9)

    # Counts only: no prompt, reply or sentence text at info level (13 §3).
    _logger.info(
        "describe done",
        extra={
            "job": job.jobId,
            "model": outcome.model,
            "promptVersion": PROMPT_VERSION,
            "attempts": outcome.attempts,
            "removed": len(outcome.removals),
            "sections": len(features.sections),
        },
    )
    blob_hash = await ctx.upload_json(outcome.result.model_dump_json(exclude_none=True))
    await ctx.progress(1.0)
    return JobOutputs(blobs={CAPABILITY.removeprefix("analysis."): blob_hash})


async def _load[T: BaseModel](
    ctx: JobContext, blobs: dict[str, str], name: str, model: type[T]
) -> T | None:
    """Downloads and validates one optional blob. A blob that does not validate is an error."""
    content_hash = blobs.get(name)
    if content_hash is None:
        return None
    data = await ctx.download(content_hash)
    try:
        return model.model_validate_json(data)
    except ValidationError as exc:
        raise ValueError(f"blobs.{name} is not a valid {model.__name__}") from exc


__all__ = ["CAPABILITY", "ParamsModel", "client_factory", "run"]
