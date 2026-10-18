"""The scaffold's smoke test: the uv workspace really installs this member."""

from importlib.metadata import distribution

import bragi_embed


def test_distribution_is_installed_under_its_declared_name() -> None:
    assert distribution("bragi-embed").metadata["Name"] == "bragi-embed"


def test_module_is_importable() -> None:
    assert bragi_embed.__name__ == "bragi_embed"
