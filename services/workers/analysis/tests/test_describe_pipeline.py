"""Reply parsing, repair and the fake-client pipeline for ``describe`` (WP-1.7)."""

from __future__ import annotations

import asyncio
import json

import pytest
from describe_support import GOOD_REPLY, FakeDescribeClient, describe_features

from bragi_analysis.describe import pipeline
from bragi_analysis.describe.prompt import SYSTEM_PROMPT
from bragi_common.generated.models import DescriptionResult


def _reply(**overrides: object) -> str:
    payload: dict[str, object] = {
        "summary": "A warm piano-led pop song. The drums hold the groove.",
        "sectionNotes": [{"index": 1, "text": "The verse stays sparse."}],
        "whatMakesItWorks": ["The arrangement builds toward the chorus."],
    }
    payload.update(overrides)
    return json.dumps(payload)


def test_a_plain_json_reply_validates() -> None:
    result = pipeline.parse_reply(GOOD_REPLY)

    assert isinstance(result, DescriptionResult)
    assert result.summary.startswith("A warm piano-led pop song")


@pytest.mark.parametrize(
    "wrapped",
    [
        "```json\n{body}\n```",
        "```\n{body}\n```",
        "Here you go:\n{body}\nThat is all.",
    ],
)
def test_a_fenced_or_chatty_reply_is_still_parsed(wrapped: str) -> None:
    assert pipeline.parse_reply(wrapped.format(body=GOOD_REPLY)).summary


def test_a_volunteered_title_is_dropped() -> None:
    result = pipeline.parse_reply(_reply(suggestedTitle="Midnight Drive"))

    assert result.suggestedTitle is None


def test_reply_keys_outside_the_contract_are_dropped() -> None:
    result = pipeline.parse_reply('{"summary": "A song.", "extra": 1, "sectionNotes": []}')

    assert result.summary == "A song."
    assert "extra" not in result.model_dump()


def test_an_unparseable_reply_raises_without_echoing_it() -> None:
    with pytest.raises(pipeline.ReplyInvalidError) as caught:
        pipeline.parse_reply("Absolutely not JSON.")

    assert "Absolutely not JSON." not in str(caught.value)


def test_a_reply_with_the_wrong_shape_raises() -> None:
    with pytest.raises(pipeline.ReplyInvalidError, match="description shape"):
        pipeline.parse_reply('{"sectionNotes": []}')


def test_the_client_is_called_with_the_requested_model_and_tokens() -> None:
    client = FakeDescribeClient([GOOD_REPLY])
    outcome = asyncio.run(
        pipeline.describe(describe_features(), client, model="claude-test-1", max_tokens=1234)
    )

    assert outcome.model == "claude-test-1"
    assert outcome.attempts == 1
    call = client.calls[0]
    assert call["model"] == "claude-test-1"
    assert call["max_tokens"] == 1234
    assert call["system"] == SYSTEM_PROMPT
    assert call["user"].startswith("<analysis>")


def test_a_malformed_reply_is_repaired_once_then_accepted() -> None:
    client = FakeDescribeClient(["not json", GOOD_REPLY])

    outcome = asyncio.run(pipeline.describe(describe_features(), client, model="m", max_tokens=64))

    assert outcome.attempts == 2
    assert len(client.calls) == 2
    assert "rejected" in client.calls[1]["user"]


def test_a_reply_that_stays_invalid_fails() -> None:
    client = FakeDescribeClient(["nope", "still nope"])

    with pytest.raises(pipeline.DescriptionInvalidError):
        asyncio.run(pipeline.describe(describe_features(), client, model="m", max_tokens=64))


def test_the_post_check_runs_inside_the_pipeline() -> None:
    reply = _reply(
        summary="The piano sets a warm mood. A sitar carries the hook.",
        sectionNotes=[{"index": 4, "text": "The outro fades."}],
    )
    client = FakeDescribeClient([reply])

    outcome = asyncio.run(pipeline.describe(describe_features(), client, model="m", max_tokens=64))

    assert outcome.result.summary == "The piano sets a warm mood."
    assert outcome.result.sectionNotes == []
    assert {removal.violation.code for removal in outcome.removals} == {
        "unsupported_instrument",
        "unknown_section",
    }
