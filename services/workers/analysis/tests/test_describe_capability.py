"""The ``analysis.describe`` capability end to end, with a fake client (WP-1.7)."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import cast

import pytest
from describe_support import (
    GOOD_REPLY,
    HASH_STRUCTURE,
    FakeContext,
    FakeDescribeClient,
    blob_bytes,
    blob_hash_map,
    make_job,
    pop_blobs,
)

from bragi_analysis.capabilities import describe
from bragi_analysis.describe.llm import (
    API_KEY_ENV,
    AnthropicClient,
    DescribeUnavailableError,
)
from bragi_analysis.describe.settings import MODEL_ENV, load
from bragi_common.cancel import JobCancelledError
from bragi_common.context import JobContext
from bragi_common.errors import JobFailure
from bragi_common.generated.models import DescriptionResult, JobOutputs


def _ctx(context: FakeContext) -> JobContext:
    return cast(JobContext, context)


def _run(
    monkeypatch: pytest.MonkeyPatch, context: FakeContext, job_params: dict[str, object]
) -> tuple[JobOutputs, FakeDescribeClient]:
    client = FakeDescribeClient([GOOD_REPLY])
    monkeypatch.setattr(describe, "client_factory", lambda: client)
    job = make_job(describe.CAPABILITY, blob_hash_map(pop_blobs()), params=job_params or None)
    outputs = asyncio.run(describe.run(job, _ctx(context)))
    return outputs, client


def test_contract_and_registration() -> None:
    assert describe.CAPABILITY == "analysis.describe"
    assert describe.ParamsModel().model is None
    from bragi_analysis import worker

    assert describe in worker.CAPABILITIES


def test_describe_publishes_a_schema_valid_description(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    context = FakeContext(tmp_path, blob_bytes(pop_blobs()))

    outputs, client = _run(monkeypatch, context, {})

    assert outputs.blobs is not None
    blob_hash = outputs.blobs["describe"]
    result = DescriptionResult.model_validate_json(context.uploads[blob_hash])
    assert result.summary.startswith("A warm piano-led pop song")
    assert [note.index for note in result.sectionNotes] == [2]
    assert context.reports[-1] == 1.0
    assert len(client.calls) == 1


def test_a_job_param_overrides_the_configured_model(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    context = FakeContext(tmp_path, blob_bytes(pop_blobs()))

    _, client = _run(monkeypatch, context, {"model": "claude-haiku-test"})

    assert client.calls[0]["model"] == "claude-haiku-test"


def test_the_environment_overrides_the_configured_model(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(MODEL_ENV, "claude-env-test")
    context = FakeContext(tmp_path, blob_bytes(pop_blobs()))

    _, client = _run(monkeypatch, context, {})

    assert client.calls[0]["model"] == "claude-env-test"


def test_a_missing_api_key_fails_with_a_clear_message(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv(API_KEY_ENV, raising=False)
    monkeypatch.setattr(describe, "client_factory", AnthropicClient.from_env)
    context = FakeContext(tmp_path, blob_bytes(pop_blobs()))
    job = make_job(describe.CAPABILITY, blob_hash_map(pop_blobs()))

    with pytest.raises(JobFailure, match=f"{API_KEY_ENV} is not set"):
        asyncio.run(describe.run(job, _ctx(context)))

    assert not context.uploads


def test_the_capability_cancels_before_calling_the_model(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    context = FakeContext(tmp_path, blob_bytes(pop_blobs()), cancel_after=0)
    job = make_job(describe.CAPABILITY, blob_hash_map(pop_blobs()))
    monkeypatch.setattr(describe, "client_factory", lambda: FakeDescribeClient([GOOD_REPLY]))

    with pytest.raises(JobCancelledError):
        asyncio.run(describe.run(job, _ctx(context)))

    assert not context.uploads


def test_a_job_with_no_blobs_is_rejected() -> None:
    context = FakeContext(Path(), {})
    job = make_job(describe.CAPABILITY)

    with pytest.raises(ValueError, match="at least one analysis blob"):
        asyncio.run(describe.run(job, _ctx(context)))


def test_an_invalid_blob_is_rejected(tmp_path: Path) -> None:
    context = FakeContext(tmp_path, {HASH_STRUCTURE: b"{}"})
    job = make_job(describe.CAPABILITY, {"structure": HASH_STRUCTURE})

    with pytest.raises(ValueError, match="not a valid StructureResult"):
        asyncio.run(describe.run(job, _ctx(context)))


def test_from_env_without_a_key_names_the_variable_not_a_secret(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv(API_KEY_ENV, raising=False)

    with pytest.raises(DescribeUnavailableError) as caught:
        AnthropicClient.from_env()

    assert API_KEY_ENV in str(caught.value)


@pytest.mark.skipif(
    not os.environ.get(API_KEY_ENV),
    reason=f"real-API smoke test: set {API_KEY_ENV} to run it",
)
def test_the_real_client_round_trips_one_tiny_request() -> None:
    """PENDING in this environment: no ``ANTHROPIC_API_KEY`` is available here."""
    client = AnthropicClient.from_env()

    reply = asyncio.run(
        client.complete(
            model=load().model,
            system="Reply with the single word: ok",
            user="Reply with the single word: ok",
            max_tokens=8,
        )
    )

    assert reply.strip()
