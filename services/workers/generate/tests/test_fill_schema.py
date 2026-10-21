"""Schema round trips for the two-sided capabilities (09 §2.1, §4.3-4.4)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from bragi_common.generated.models import (
    GenerateFillResult,
    GenerateInpaintParams,
    GenerateTransitionParams,
)


def examples() -> Path:
    """``packages/schemas/examples``."""
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "packages" / "schemas" / "examples"
        if candidate.is_dir():
            return candidate
    raise AssertionError("could not locate packages/schemas/examples")


def test_inpaint_params_example_round_trips() -> None:
    text = (examples() / "GenerateInpaintParams.json").read_text(encoding="utf-8")
    params = GenerateInpaintParams.model_validate_json(text)

    assert params.gapBars == 4
    assert params.overlapBars == 2
    assert params.n == 3
    assert json.loads(params.model_dump_json(exclude_none=True)) == json.loads(text)


def test_transition_params_example_round_trips() -> None:
    text = (examples() / "GenerateTransitionParams.json").read_text(encoding="utf-8")
    params = GenerateTransitionParams.model_validate_json(text)

    assert params.lengthBars == 2
    assert params.n == 3
    assert json.loads(params.model_dump_json(exclude_none=True)) == json.loads(text)


def test_fill_result_example_round_trips() -> None:
    text = (examples() / "GenerateFillResult.json").read_text(encoding="utf-8")
    result = GenerateFillResult.model_validate_json(text)

    assert result.passed is True
    assert result.seamScore is not None and result.endSeamScore is not None
    assert result.startOffsetSamples < 0 < result.endOffsetSamples
    assert [step.step for step in result.steps][-2:] == ["match", "final_seam"]
    assert json.loads(result.model_dump_json(exclude_none=True)) == json.loads(text)


def test_a_null_end_seam_score_is_valid() -> None:
    text = (examples() / "GenerateFillResult.json").read_text(encoding="utf-8")
    document = json.loads(text)
    document["endSeamScore"] = None
    result = GenerateFillResult.model_validate(document)
    assert result.endSeamScore is None


def test_out_of_range_fill_params_are_rejected() -> None:
    inpaint = json.loads((examples() / "GenerateInpaintParams.json").read_text(encoding="utf-8"))
    for field, value in (("gapBars", 0), ("overlapBars", 5), ("n", 0)):
        with pytest.raises(ValidationError):
            GenerateInpaintParams.model_validate({**inpaint, field: value})
    transition = json.loads(
        (examples() / "GenerateTransitionParams.json").read_text(encoding="utf-8")
    )
    for field, value in (("lengthBars", 0), ("lengthBars", 5), ("n", 5)):
        with pytest.raises(ValidationError):
            GenerateTransitionParams.model_validate({**transition, field: value})


def test_unknown_fill_fields_are_rejected() -> None:
    inpaint = json.loads((examples() / "GenerateInpaintParams.json").read_text(encoding="utf-8"))
    with pytest.raises(ValidationError, match="Extra inputs"):
        GenerateInpaintParams.model_validate({**inpaint, "bars": 4})
    transition = json.loads(
        (examples() / "GenerateTransitionParams.json").read_text(encoding="utf-8")
    )
    with pytest.raises(ValidationError, match="Extra inputs"):
        GenerateTransitionParams.model_validate({**transition, "overlapBars": 1})
