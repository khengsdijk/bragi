"""Configuration for ``describe``: ``config/describe.toml``, overridable by the environment."""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass
from importlib import resources

#: Environment variable that overrides the configured model ID.
MODEL_ENV = "BRAGI_DESCRIBE_MODEL"


@dataclass(frozen=True)
class DescribeConfig:
    """The parsed ``config/describe.toml``."""

    model: str
    maxTokens: int
    blockedTerms: tuple[str, ...]


def load() -> DescribeConfig:
    """Reads ``config/describe.toml`` from the installed package."""
    text = resources.files("bragi_analysis").joinpath("config/describe.toml").read_text("utf-8")
    raw = tomllib.loads(text)
    return DescribeConfig(
        model=str(raw["model"]),
        maxTokens=int(raw["maxTokens"]),
        blockedTerms=tuple(str(term) for term in raw.get("blockedTerms", [])),
    )


def resolve_model(config: DescribeConfig, override: str | None) -> str:
    """The job param wins, then the environment, then the file."""
    if override:
        return override
    return os.environ.get(MODEL_ENV) or config.model


__all__ = ["MODEL_ENV", "DescribeConfig", "load", "resolve_model"]
