"""Features -> prompt -> Claude -> ``DescriptionResult``, with the grounding post-check (``specs/04`` §6.3).

The steps are: build the messages, call the model through a ``DescribeClient``, parse the reply as the
single JSON object the prompt asks for (one repair retry when it is malformed), validate it against
the generated ``DescriptionResult`` model, then run the grounding post-check. Unsupported claims are
removed and recorded. The result is rejected only when the summary is left with nothing grounded.

Errors from validation carry error *types and locations* only, never the reply text, so a malformed
reply cannot leak into logs.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from pydantic import ValidationError

from bragi_common.generated.models import DescriptionResult

from bragi_analysis.describe import grounding
from bragi_analysis.describe.features import DescribeFeatures
from bragi_analysis.describe.llm import DescribeClient
from bragi_analysis.describe.prompt import SYSTEM_PROMPT, user_message

#: The keys of the reply the prompt asks for. Anything else is dropped before validation.
REPLY_KEYS = ("summary", "sectionNotes", "whatMakesItWorks")


class ReplyInvalid(Exception):
    """The reply is not the JSON object the prompt asks for. The message names no reply text."""


class DescriptionInvalid(Exception):
    """The reply stayed invalid after the repair retry."""


@dataclass(frozen=True)
class DescribeOutcome:
    """A grounded description and the record of what the post-check removed."""

    result: DescriptionResult
    removals: tuple[grounding.Removal, ...]
    attempts: int
    model: str


def parse_reply(text: str) -> DescriptionResult:
    """Parses and validates one model reply. Fenced JSON is accepted.

    Raises:
        ReplyInvalid: when the reply is not JSON or does not match the ``DescriptionResult`` shape.
    """
    body = _strip_fence(text.strip())
    try:
        data: Any = json.loads(body)
    except json.JSONDecodeError:
        start, end = body.find("{"), body.rfind("}")
        if start < 0 or end <= start:
            raise ReplyInvalid("reply is not a JSON object") from None
        try:
            data = json.loads(body[start : end + 1])
        except json.JSONDecodeError:
            raise ReplyInvalid("reply is not a JSON object") from None
    if not isinstance(data, dict):
        raise ReplyInvalid("reply is not a JSON object")
    candidate: dict[str, Any] = {key: data[key] for key in REPLY_KEYS if key in data}
    candidate["schemaVersion"] = 1
    try:
        return DescriptionResult.model_validate(candidate)
    except ValidationError as exc:
        locations = sorted({".".join(str(part) for part in err["loc"]) for err in exc.errors()})
        raise ReplyInvalid(f"reply does not match the description shape at {locations}") from None


def _strip_fence(text: str) -> str:
    if not text.startswith("```"):
        return text
    lines = text.splitlines()
    lines = lines[1:]
    if lines and lines[-1].strip().startswith("```"):
        lines = lines[:-1]
    return "\n".join(lines).strip()


async def describe(
    features: DescribeFeatures,
    client: DescribeClient,
    *,
    model: str,
    max_tokens: int,
    blocked_terms: tuple[str, ...] = (),
    repair_attempts: int = 1,
) -> DescribeOutcome:
    """Produces the grounded description for ``features``.

    Raises:
        DescriptionInvalid: when the reply stays malformed after ``repair_attempts`` repairs.
        grounding.GroundingRejected: when no summary sentence is grounded.
    """
    user = user_message(features)
    attempts = 0
    reply = await client.complete(model=model, system=SYSTEM_PROMPT, user=user, max_tokens=max_tokens)
    attempts += 1
    parsed: DescriptionResult | None = None
    for repair in range(repair_attempts + 1):
        try:
            parsed = parse_reply(reply)
            break
        except ReplyInvalid as exc:
            if repair == repair_attempts:
                raise DescriptionInvalid(str(exc)) from None
            repair_note = (
                f"\n\nYour previous reply was rejected: {exc}. "
                "Reply again with only the single JSON object the instructions describe."
            )
            reply = await client.complete(
                model=model,
                system=SYSTEM_PROMPT,
                user=user + repair_note,
                max_tokens=max_tokens,
            )
            attempts += 1
    assert parsed is not None  # the loop either breaks with a parse or raises
    report = grounding.ground(parsed, features, blocked_terms)
    return DescribeOutcome(result=report.result, removals=report.removals, attempts=attempts, model=model)


__all__ = [
    "DescribeOutcome",
    "DescriptionInvalid",
    "ReplyInvalid",
    "describe",
    "parse_reply",
]
