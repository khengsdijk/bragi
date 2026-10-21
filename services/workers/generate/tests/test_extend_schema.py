"""Schema round trip and validation for ``generate.extend`` (09 §2.1, §4.2)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from bragi_common.generated.models import GenerateExtendParams, GenerateExtendResult


def examples() -> Path:
    """``packages/schemas/examples``."""
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "packages" / "schemas" / "examples"
        if candidate.is_dir():
            return candidate
    raise AssertionError("could not locate packages/schemas/examples")


def test_params_example_round_trips() -> None:
    text = (examples() / "GenerateExtendParams.json").read_text(encoding="utf-8")
    params = GenerateExtendParams.model_validate_json(text)

    assert params.bars == 15
    assert params.overlapBars == 2
    assert params.n == 3
    assert params.context.seed == 1234
    dumped = params.model_dump_json(exclude_none=True)
    assert json.loads(dumped) == json.loads(text)


def test_result_example_round_trips() -> None:
    text = (examples() / "GenerateExtendResult.json").read_text(encoding="utf-8")
    result = GenerateExtendResult.model_validate_json(text)

    assert result.passed is True
    assert result.seamScore is not None
    assert [step.step for step in result.steps] == [
        "sanity",
        "tempo",
        "key",
        "beat_align",
        "splice",
        "match",
        "final_seam",
    ]
    dumped = result.model_dump_json(exclude_none=True)
    assert json.loads(dumped) == json.loads(text)


def test_a_null_seam_score_is_valid() -> None:
    text = (examples() / "GenerateExtendResult.json").read_text(encoding="utf-8")
    document = json.loads(text)
    document["seamScore"] = None
    result = GenerateExtendResult.model_validate(document)
    assert result.seamScore is None


def test_out_of_range_params_are_rejected() -> None:
    text = (examples() / "GenerateExtendParams.json").read_text(encoding="utf-8")
    for field, value in (("bars", 33), ("n", 0), ("overlapBars", 9), ("direction", "sideways")):
        document = {**json.loads(text), field: value}
        with pytest.raises(ValidationError):
            GenerateExtendParams.model_validate(document)


def test_unknown_fields_are_rejected() -> None:
    text = (examples() / "GenerateExtendParams.json").read_text(encoding="utf-8")
    with pytest.raises(ValidationError, match="Extra inputs"):
        GenerateExtendParams.model_validate({**json.loads(text), "tempoBpm": 120})
