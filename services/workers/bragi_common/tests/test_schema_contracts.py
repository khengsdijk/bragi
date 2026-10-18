"""The cross-language schema contract tests (specs/12-roadmap.md WP-0.2).

The same documents are tested in TypeScript
(``packages/schemas/src/__tests__/contracts.test.ts``) and Rust
(``crates/bragi-model/tests/schema_contracts.rs``): one JSON Schema set, three sets of generated
types, one behaviour.

Proofs here:

1. ``fixtures/projects/example-02-10.json`` — the example document in specs/02-song-model.md §10 —
   validates into ``bragi_common.generated.models.Project``.
2. JSON → typed → JSON round-trips losslessly, for that document and for one example per root type.
3. Every invalid document in ``fixtures/projects/invalid-cases.json`` is rejected in Pydantic when
   the case says Python must reject it, and accepted when it says otherwise.
4. ``models.ROOT_TYPES`` equals the set of ``packages/schemas/examples/*.json``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, cast

import pytest
from pydantic import TypeAdapter, ValidationError

from bragi_common.generated import models


def repo_root() -> Path:
    """The repository root, found by walking up from this file."""
    for parent in Path(__file__).resolve().parents:
        if (parent / "packages" / "schemas" / "examples").is_dir():
            return parent
    raise AssertionError("could not locate the repository root")


def examples_dir() -> Path:
    """``packages/schemas/examples/``."""
    return repo_root() / "packages" / "schemas" / "examples"


def example_names() -> list[str]:
    """The root type names that have an example file, sorted."""
    return sorted(path.stem for path in examples_dir().glob("*.json"))


def adapter_for(name: str) -> TypeAdapter[Any]:
    """A Pydantic adapter for a root type.

    Most roots are ``BaseModel`` subclasses, but a root that is only a union is a PEP 695 type
    alias (``type Op = …``), which has no ``model_validate_json``. A ``TypeAdapter`` validates and
    serializes both, which is what the round-trip proof needs.
    """
    return TypeAdapter(getattr(models, name))


def read_example(name: str) -> tuple[str, Any]:
    """The raw text and the parsed JSON of one example."""
    text = (examples_dir() / f"{name}.json").read_text(encoding="utf-8")
    return text, json.loads(text)


def normalize(value: Any) -> Any:
    """JSON value equality as the acceptance criterion means it.

    Objects compare key-wise with order ignored, numbers compare numerically (``0`` and ``0.0`` are
    equal), and a boolean is never equal to a number — which is why booleans are tagged and numbers
    are not compared with ``==``.
    """
    if isinstance(value, bool):
        return ("bool", value)
    if isinstance(value, int | float):
        return ("number", float(value))
    if isinstance(value, dict):
        return {key: normalize(item) for key, item in value.items()}
    if isinstance(value, list):
        return [normalize(item) for item in value]
    return value


def invalid_cases() -> dict[str, dict[str, Any]]:
    """The invalid documents, by case name."""
    path = repo_root() / "fixtures" / "projects" / "invalid-cases.json"
    cases = cast("list[dict[str, Any]]", json.loads(path.read_text(encoding="utf-8"))["cases"])
    assert len(cases) >= 10, "too few invalid cases"
    return {case["name"]: case for case in cases}


def test_every_root_type_has_an_example_and_a_model() -> None:
    assert list(models.ROOT_TYPES) == example_names()
    for name in models.ROOT_TYPES:
        text, _ = read_example(name)
        adapter_for(name).validate_json(text)


def test_the_spec_example_validates() -> None:
    text = (repo_root() / "fixtures" / "projects" / "example-02-10.json").read_text(
        encoding="utf-8"
    )
    project = models.Project.model_validate_json(text)
    assert project.id == "prj_01JAB3QK7M9P2V6XWN0T4Y8ZB5"
    assert len(project.tracks) == 1


@pytest.mark.parametrize("name", example_names())
def test_every_example_round_trips_losslessly(name: str) -> None:
    text, original = read_example(name)
    adapter = adapter_for(name)
    value = adapter.validate_json(text)

    once = adapter.dump_json(value, exclude_none=True)
    twice = adapter.dump_json(value, exclude_none=True)
    assert once == twice, f"{name} is not stable across two serializations"
    assert normalize(json.loads(once)) == normalize(original), f"{name} lost or changed a value"


@pytest.mark.parametrize("name", sorted(invalid_cases()))
def test_invalid_documents(name: str) -> None:
    case = invalid_cases()[name]
    adapter = adapter_for(case["type"])
    if "python" in case["checkedBy"]:
        with pytest.raises(ValidationError):
            adapter.validate_python(case["document"])
    else:
        adapter.validate_python(case["document"])
