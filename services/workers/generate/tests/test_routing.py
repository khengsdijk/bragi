"""Routing table, env override and the capability registry (09 §2, §3.1)."""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

from bragi_generate import routing


def repo_root() -> Path:
    """The repository root, found by walking up from this file."""
    for parent in Path(__file__).resolve().parents:
        if (parent / "config" / "generation_routes.yaml").is_file():
            return parent
    raise AssertionError("could not locate the repository root")


def test_the_checked_in_table_routes_both_tiers_to_ace_step() -> None:
    routes = routing.load_routes()
    assert routes["generate.extend"] == {"preview": "ace_step", "hq": "ace_step"}


def test_env_override_forces_the_fake_backend_everywhere(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(routing.ENV_OVERRIDE, "fake")
    assert routing.backend_name("generate.extend", "preview") == "fake"
    assert routing.backend_name("generate.extend", "hq") == "fake"


def test_an_explicit_override_beats_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(routing.ENV_OVERRIDE, "fake")
    assert routing.backend_name("generate.extend", "preview", override="ace_step") == "ace_step"


def test_unknown_capability_or_tier_is_rejected() -> None:
    routes = routing.load_routes()
    with pytest.raises(ValueError, match="no route for capability"):
        routing.backend_name("generate.inpaint", "preview", routes=routes)
    with pytest.raises(ValueError, match="unknown tier"):
        routing.backend_name("generate.extend", "ultra", routes=routes)


def test_malformed_table_is_rejected(tmp_path: Path) -> None:
    path = tmp_path / "routes.yaml"
    path.write_text("routes:\n  generate.extend:\n    ultra: ace_step\n", encoding="utf-8")
    with pytest.raises(ValueError, match="unknown tier"):
        routing.load_routes(path)


def test_backend_for_builds_the_named_backend() -> None:
    backend = routing.backend_for("generate.extend", "preview", override="fake")
    assert backend.name == "fake"


def test_unknown_backend_name_is_rejected() -> None:
    with pytest.raises(ValueError, match="unknown backend"):
        routing.backend_for("generate.extend", "preview", override="does-not-exist")


def test_the_capability_registry_lists_only_extend_as_implemented() -> None:
    path = repo_root() / "services" / "workers" / "generate" / "capabilities.yaml"
    document = yaml.safe_load(path.read_text(encoding="utf-8"))
    capabilities = document["capabilities"]

    implemented = [name for name, entry in capabilities.items() if entry["implemented"]]
    assert implemented == ["generate.extend"]
    assert set(capabilities) == {
        "generate.extend",
        "generate.inpaint",
        "generate.variation",
        "generate.transition",
        "generate.stem",
        "generate.text2music",
        "generate.fx",
        "transform.timbre",
        "transform.style",
        "transform.stem_resynth",
    }
    assert all(isinstance(entry["credits"], int) for entry in capabilities.values())
