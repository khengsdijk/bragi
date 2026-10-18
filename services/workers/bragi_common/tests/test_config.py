"""Configuration tests: defaults, overrides and validation (01 §8)."""

from __future__ import annotations

import pytest

from bragi_common.config import Settings


def test_every_value_has_a_working_local_default() -> None:
    settings = Settings()
    assert settings.database_url.startswith("postgres://")
    assert settings.nats_url.startswith("nats://")
    assert settings.s3_bucket == "bragi-blobs"
    assert settings.otel_enabled is True
    assert settings.max_attempts >= 1


def test_environment_overrides() -> None:
    with pytest.MonkeyPatch.context() as mp:
        mp.setenv("NATS_URL", "nats://nats:4222")
        mp.setenv("OTEL_ENABLED", "false")
        settings = Settings()
    assert settings.nats_url == "nats://nats:4222"
    assert settings.otel_enabled is False
