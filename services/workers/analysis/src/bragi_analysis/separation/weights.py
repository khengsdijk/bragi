"""Pinned model weights: lock-file access, hash verification and the build-time fetch.

``python -m bragi_analysis.separation.weights <dir>`` runs in the Docker build
(``specs/04`` §9: weights are pulled at image build, pinned by hash, never at runtime).
The worker itself only calls :func:`verified_model_dir`, which never touches the network.
"""

from __future__ import annotations

import hashlib
import json
import sys
import urllib.request
from dataclasses import dataclass
from pathlib import Path

LOCK_PATH = Path(__file__).with_name("models_lock.json")


class WeightsError(Exception):
    """Weights are missing, or do not match the pinned hash."""


@dataclass(frozen=True)
class ModelPin:
    """One pinned model, as recorded in ``models_lock.json`` and ``MODELS.md``."""

    name: str
    stage_version: str
    repo: str
    revision: str
    bag: str
    files: dict[str, str]


def load_lock(path: Path = LOCK_PATH) -> dict[str, ModelPin]:
    """Reads the lock file."""
    raw = json.loads(path.read_text(encoding="utf-8"))
    return {
        name: ModelPin(
            name=name,
            stage_version=entry["stageVersion"],
            repo=entry["repo"],
            revision=entry["revision"],
            bag=entry["bag"],
            files=dict(entry["files"]),
        )
        for name, entry in raw["models"].items()
    }


def pin_for(name: str) -> ModelPin:
    """The pin for ``name``, or a clear error for an unknown model."""
    pins = load_lock()
    if name not in pins:
        raise WeightsError(f"unknown separation model {name!r}; pinned: {sorted(pins)}")
    return pins[name]


def sha256_file(path: Path) -> str:
    """Streams a file through SHA-256."""
    hasher = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            hasher.update(block)
    return hasher.hexdigest()


def verified_model_dir(root: Path, name: str) -> Path:
    """``root/name`` after checking every pinned file exists with the pinned SHA-256."""
    pin = pin_for(name)
    directory = root / name
    for filename, expected in pin.files.items():
        path = directory / filename
        if not path.is_file():
            raise WeightsError(f"{path} is missing; weights are fetched at image build")
        actual = sha256_file(path)
        if actual != expected:
            raise WeightsError(f"{path}: sha256 {actual} does not match the pinned {expected}")
    return directory


def fetch(root: Path, names: list[str] | None = None) -> None:
    """Downloads the pinned revision of each model into ``root/<name>/`` and verifies it."""
    for name, pin in load_lock().items():
        if names and name not in names:
            continue
        directory = root / name
        directory.mkdir(parents=True, exist_ok=True)
        for filename, expected in pin.files.items():
            url = f"https://huggingface.co/{pin.repo}/resolve/{pin.revision}/{filename}"
            target = directory / filename
            with urllib.request.urlopen(url) as response:
                target.write_bytes(response.read())
            actual = sha256_file(target)
            if actual != expected:
                target.unlink()
                raise WeightsError(f"{url}: sha256 {actual} does not match the pinned {expected}")
            print(f"fetched {name}/{filename} ({expected[:12]}...)")


if __name__ == "__main__":
    fetch(Path(sys.argv[1]), sys.argv[2:] or None)
