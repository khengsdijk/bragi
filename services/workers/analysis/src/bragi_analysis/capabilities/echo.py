"""The ``echo`` capability: the pipeline's smoke test (WP-0.7).

It exercises every part of the framework a real capability will use — params
validation, progress, cancellation, verified S3 input download and
content-addressed output upload — without a model. The acceptance integration
test submits it and expects ``progress`` then ``completed``.
"""

from __future__ import annotations

import asyncio
import json

from pydantic import BaseModel, ConfigDict

from bragi_common.cancel import JobCancelledError
from bragi_common.context import JobContext
from bragi_common.generated.models import JobOutputs, JobRequest
from bragi_common.protocol import params_of

#: The capability name, and the last two tokens of its NATS subject
#: (``jobs.echo.<priority>``, ``specs/05`` §4.1).
CAPABILITY = "echo"


class ParamsModel(BaseModel):
    """Parameters for ``echo`` (validated by the framework before ``run``)."""

    model_config = ConfigDict(extra="forbid")

    #: How many progress reports to emit (default 3).
    steps: int = 3
    #: Artificial delay between steps, mirroring a slow model.
    delay_ms: int = 0


async def run(job: JobRequest, ctx: JobContext) -> JobOutputs:
    """Download every input, verify it, and echo a manifest back."""
    params = ParamsModel.model_validate(params_of(job))

    for step in range(1, params.steps + 1):
        if await ctx.cancelled():
            raise JobCancelledError(f"job {job.jobId} cancelled at step {step}")
        await ctx.progress(step / params.steps)
        if params.delay_ms > 0:
            await asyncio.sleep(params.delay_ms / 1000)

    verified: dict[str, str] = {}
    for role, content_hash in job.inputs.assets.items():
        await ctx.download(content_hash)
        verified[role] = content_hash

    manifest = json.dumps(
        {"capability": CAPABILITY, "inputs": verified, "params": params_of(job)},
        sort_keys=True,
    )
    blob = await ctx.upload_json(manifest)
    return JobOutputs(assets=verified, blobs={"manifest": blob})
