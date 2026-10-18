"""The scaffold's smoke test: the uv workspace really installs this member."""

from importlib.metadata import distribution

import bragi_analysis


def test_distribution_is_installed_under_its_declared_name() -> None:
    assert distribution("bragi-analysis").metadata["Name"] == "bragi-analysis"


def test_module_is_importable() -> None:
    assert bragi_analysis.__name__ == "bragi_analysis"
