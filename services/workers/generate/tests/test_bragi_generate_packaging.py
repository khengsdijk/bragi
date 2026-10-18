"""The scaffold's smoke test: the uv workspace really installs this member."""

from importlib.metadata import distribution

import bragi_generate


def test_distribution_is_installed_under_its_declared_name() -> None:
    assert distribution("bragi-generate").metadata["Name"] == "bragi-generate"


def test_module_is_importable() -> None:
    assert bragi_generate.__name__ == "bragi_generate"
