"""Backend routing for the generation capabilities (``specs/09-generation.md`` §3.1).

``config/generation_routes.yaml`` maps ``(capability, tier)`` to a backend name, so a
model swap is configuration rather than a code change. ``BRAGI_GENERATION_BACKEND``
overrides every entry with one backend; ``fake`` makes the tests and the live e2e run
without a model.
"""

from __future__ import annotations

import os
from collections.abc import Callable, Mapping
from pathlib import Path

import yaml

from bragi_generate.backend import GenerationBackend
from bragi_generate.backends.fake import FakeBackend

#: The only tiers of 09 §5.
TIERS: frozenset[str] = frozenset({"preview", "hq"})
#: Forces one backend everywhere (tests, live e2e); see 09 §3.1.
ENV_OVERRIDE = "BRAGI_GENERATION_BACKEND"
#: An alternate route file, for tests or a deployment that mounts one.
PATH_ENV = "BRAGI_GENERATION_ROUTES"
RELATIVE_PATH = Path("config/generation_routes.yaml")


def _build_fake() -> GenerationBackend:
    return FakeBackend()


def _build_ace_step() -> GenerationBackend:
    # Imported lazily: the fake backend must work when no model checkout exists.
    from bragi_generate.backends.ace_step import AceStepBackend

    return AceStepBackend()


#: Backend names that a route may use. Tests can monkeypatch this mapping.
BACKEND_FACTORIES: dict[str, Callable[[], GenerationBackend]] = {
    "fake": _build_fake,
    "ace_step": _build_ace_step,
}


def default_path() -> Path:
    """The route file: ``$BRAGI_GENERATION_ROUTES``, else the repo root's."""
    override = os.environ.get(PATH_ENV)
    if override:
        path = Path(override)
        if not path.is_file():
            raise FileNotFoundError(f"{PATH_ENV} points at a missing file: {path}")
        return path
    for parent in Path(__file__).resolve().parents:
        candidate = parent / RELATIVE_PATH
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(f"no {RELATIVE_PATH} above {Path(__file__).resolve()}")


def load_routes(path: Path | str | None = None) -> dict[str, dict[str, str]]:
    """Reads and validates the route table.

    Raises:
        ValueError: when the file is not a ``routes`` map of capability → tier → name.
    """
    source = Path(path) if path is not None else default_path()
    raw: object = yaml.safe_load(source.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError(f"{source} must be a mapping")
    section = raw.get("routes")
    if not isinstance(section, dict):
        raise ValueError(f"{source} needs a 'routes' mapping")
    routes: dict[str, dict[str, str]] = {}
    for capability, tiers in section.items():
        if not isinstance(capability, str) or not capability:
            raise ValueError(f"{source}: capability names must be non-empty strings")
        if not isinstance(tiers, dict):
            raise ValueError(f"{source}: routes.{capability} must map tiers to backends")
        entries: dict[str, str] = {}
        for tier, backend in tiers.items():
            if tier not in TIERS:
                raise ValueError(f"{source}: routes.{capability} has unknown tier {tier!r}")
            if not isinstance(backend, str) or not backend:
                raise ValueError(f"{source}: routes.{capability}.{tier} must be a backend name")
            entries[tier] = backend
        routes[capability] = entries
    return routes


def backend_name(
    capability: str,
    tier: str,
    *,
    routes: Mapping[str, Mapping[str, str]] | None = None,
    override: str | None = None,
) -> str:
    """Resolves the backend name for one capability and tier.

    ``override`` (default: ``$BRAGI_GENERATION_BACKEND``) wins over the table.
    """
    forced = override if override is not None else os.environ.get(ENV_OVERRIDE)
    if forced:
        return forced
    table = routes if routes is not None else load_routes()
    if tier not in TIERS:
        raise ValueError(f"unknown tier {tier!r}")
    try:
        entry = table[capability]
    except KeyError as error:
        raise ValueError(f"no route for capability {capability!r}") from error
    try:
        return entry[tier]
    except KeyError as error:
        raise ValueError(f"no route for {capability!r} at tier {tier!r}") from error


def backend_for(
    capability: str,
    tier: str,
    *,
    routes: Mapping[str, Mapping[str, str]] | None = None,
    override: str | None = None,
    factories: Mapping[str, Callable[[], GenerationBackend]] | None = None,
) -> GenerationBackend:
    """Builds the backend the route selects."""
    name = backend_name(capability, tier, routes=routes, override=override)
    registry = factories if factories is not None else BACKEND_FACTORIES
    try:
        factory = registry[name]
    except KeyError as error:
        known = ", ".join(sorted(registry))
        raise ValueError(f"unknown backend {name!r} (known: {known})") from error
    return factory()


__all__ = [
    "BACKEND_FACTORIES",
    "ENV_OVERRIDE",
    "TIERS",
    "backend_for",
    "backend_name",
    "default_path",
    "load_routes",
]
