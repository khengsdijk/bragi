"""Features -> prompt -> LLM -> ``DescriptionResult``, with the grounding post-check (04 §6.3).

The steps are: build the messages, call the model through a ``DescribeClient``, parse the reply as
the single JSON object the prompt asks for (one repair retry when it is malformed), validate it
against the generated ``DescriptionResult`` model, then run the grounding post-check. Unsupported
claims are removed and recorded. The result is rejected only when the summary is left with nothing
grounded.

Errors from validation carry error *types and locations* only, never the reply text, so a malformed
reply cannot leak into logs.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from pydantic import ValidationError

from bragi_analysis.describe import grounding
from bragi_analysis.describe.features import DescribeFeatures
from bragi_analysis.describe.llm import DescribeClient
from bragi_analysis.describe.prompt import SYSTEM_PROMPT, user_message
from bragi_common.generated.models import DescriptionResult


class ReplyInvalidError(Exception):
    """The reply is not the JSON object the prompt asks for. The message names no reply text."""


class DescriptionInvalidError(Exception):
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
        ReplyInvalidError: when the reply is not JSON or does not match the shape.
    """
    body = _strip_fence(text.strip())
    try:
        data: Any = json.loads(body)
    except json.JSONDecodeError:
        start, end = body.find("{"), body.rfind("}")
        if start < 0 or end <= start:
            raise ReplyInvalidError("reply is not a JSON object") from None
        try:
            data = json.loads(body[start : end + 1])
        except json.JSONDecodeError:
            raise ReplyInvalidError("reply is not a JSON object") from None
    if not isinstance(data, dict):
        raise ReplyInvalidError("reply is not a JSON object")
    # Keep only the contract keys; a missing list defaults to empty, a missing summary fails the
    # length check below. Anything the model volunteers extra (a title) never reaches the blob.
    candidate: dict[str, Any] = {
        "summary": data.get("summary", ""),
        "sectionNotes": data.get("sectionNotes", []),
        "whatMakesItWorks": data.get("whatMakesItWorks", []),
        "schemaVersion": 1,
    }
    try:
        return DescriptionResult.model_validate(candidate)
    except ValidationError as exc:
        locations = sorted({".".join(str(part) for part in err["loc"]) for err in exc.errors()})
        raise ReplyInvalidError(
            f"reply does not match the description shape at {locations}"
        ) from None


def _strip_fence(text: str) -> str:
    if not text.startswith("```"):
        return text
    lines = text.splitlines()
    lines = lines[1:]
    if lines and lines[-1].strip().startswith("```"):
        lines = lines[:-1]
    return "\n".join(lines).strip()


def _repair_note(error: ReplyInvalidError) -> str:
    return (
        f"\n\nYour previous reply was rejected: {error}. "
        "Reply again with only the single JSON object the instructions describe."
    )


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
        DescriptionInvalidError: when the reply stays malformed after ``repair_attempts`` repairs.
        grounding.GroundingRejectedError: when no summary sentence is grounded.
    """
    user = user_message(features)
    attempts = 1
    reply = await client.complete(
        model=model, system=SYSTEM_PROMPT, user=user, max_tokens=max_tokens
    )
    parsed: DescriptionResult | None = None
    for repair in range(repair_attempts + 1):
        try:
            parsed = parse_reply(reply)
        except ReplyInvalidError as exc:
            if repair == repair_attempts:
                raise DescriptionInvalidError(str(exc)) from None
            reply = await client.complete(
                model=model,
                system=SYSTEM_PROMPT,
                user=user + _repair_note(exc),
                max_tokens=max_tokens,
            )
            attempts += 1
            continue
        break
    if parsed is None:  # unreachable: the last repair attempt raises
        raise DescriptionInvalidError("the reply stayed invalid")
    report = grounding.ground(parsed, features, blocked_terms)
    return DescribeOutcome(
        result=report.result,
        removals=report.removals,
        attempts=attempts,
        model=model,
    )


__all__ = [
    "DescribeOutcome",
    "DescriptionInvalidError",
    "ReplyInvalidError",
    "describe",
    "parse_reply",
]
