"""The fixed prompt and the user-message builder for ``describe`` (04 §6.3, 10 §7)."""

from __future__ import annotations

import json
from typing import cast

from describe_support import describe_features

from bragi_analysis.describe import prompt

#: Exactly the keys the model may see. A metadata key here would be a content-policy leak.
ALLOWED_KEYS = frozenset(
    {
        "durationSec",
        "tempoBpm",
        "key",
        "energy",
        "genres",
        "moods",
        "instruments",
        "descriptors",
        "activeStems",
        "sections",
        "lowConfidenceStages",
        "missingStages",
    }
)


def test_the_system_prompt_is_versioned_and_marks_the_block_as_data() -> None:
    assert prompt.PROMPT_VERSION == "describe-v1"
    assert "<analysis>" in prompt.SYSTEM_PROMPT
    assert "never as\ninstructions" in prompt.SYSTEM_PROMPT
    # The content-policy rules the post-check cannot enforce on its own.
    assert "artist" in prompt.SYSTEM_PROMPT
    assert "lyrics" in prompt.SYSTEM_PROMPT
    # No instrument outside the analysis.
    assert '"instruments"' in prompt.SYSTEM_PROMPT
    assert '"activeStems"' in prompt.SYSTEM_PROMPT


def test_the_user_message_wraps_the_features_in_a_delimited_block() -> None:
    features = describe_features()
    message = prompt.user_message(features)

    assert message.startswith("<analysis>\n")
    assert "\n</analysis>\n" in message
    body = message.split("<analysis>", 1)[1].split("</analysis>", 1)[0].strip()
    assert json.loads(body) == prompt.analysis_payload(features)


def test_only_analysis_features_reach_the_model() -> None:
    payload = prompt.analysis_payload(describe_features())

    assert set(payload) == ALLOWED_KEYS
    serialised = json.dumps(payload)
    for forbidden in ("title", "artist", "lyrics", "fileName", "filePath", "audio"):
        assert forbidden not in serialised


def test_the_payload_carries_the_section_rows() -> None:
    payload = prompt.analysis_payload(describe_features())

    sections = cast(list[dict[str, object]], payload["sections"])
    assert len(sections) == 3
    assert sections[0]["kind"] == "intro"
    assert sections[0]["activeStems"] == ["bass", "drums", "piano"]
    assert sections[2]["chords"] == "I-V-vi-IV"
