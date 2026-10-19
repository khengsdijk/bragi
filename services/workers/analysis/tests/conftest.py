"""Shared pytest setup for the analysis worker tests."""

from __future__ import annotations

import os

import pytest


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    """Skips ``@pytest.mark.weights`` tests unless ``BRAGI_MODELS_DIR`` points at real weights."""
    if os.environ.get("BRAGI_MODELS_DIR"):
        return
    skip = pytest.mark.skip(reason="needs the pinned weights: set BRAGI_MODELS_DIR (see MODELS.md)")
    for item in items:
        if "weights" in item.keywords:
            item.add_marker(skip)
