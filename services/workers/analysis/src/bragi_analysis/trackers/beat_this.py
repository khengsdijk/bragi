"""Beat This! (Foscarin et al., ISMIR 2024), the v1 beat and downbeat tracker.

Code and weights are MIT-licensed (``services/workers/MODELS.md``). The weights
are **never** committed and **never** downloaded at runtime (04 §9): the image
build fetches ``final0.ckpt`` to ``BRAGI_BEAT_THIS_CHECKPOINT`` and this loader
refuses any file whose SHA-256 differs from the pin below.

``torch`` and ``beat_this`` live in the optional ``ml`` extra, so this module
imports them lazily and everything else works without them.
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import Any

import numpy as np
from numpy.typing import NDArray

from bragi_analysis.trackers.base import BeatEstimate

#: SHA-256 of ``final0.ckpt`` (the model trained on all data except GTZAN, seed 0).
CHECKPOINT_SHA256 = "8c328b45f59d8dd3dff219253ff6a8d6482be57d0133a29140e2febbf8eb8331"
CHECKPOINT_ENV = "BRAGI_BEAT_THIS_CHECKPOINT"


class BeatThisUnavailableError(RuntimeError):
    """Beat This! cannot run here: the ``ml`` extra or the pinned weights are missing."""


def checkpoint_path() -> Path | None:
    """The configured checkpoint file, if the environment names one."""
    raw = os.environ.get(CHECKPOINT_ENV)
    return Path(raw) if raw else None


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def is_available() -> bool:
    """True when ``beat_this`` imports and the checkpoint file exists."""
    path = checkpoint_path()
    if path is None or not path.is_file():
        return False
    try:
        import beat_this.inference  # noqa: F401
    except ImportError:
        return False
    return True


class BeatThisTracker:
    """Runs Beat This! on CPU (or CUDA when ``device`` says so)."""

    name = "beat_this"
    stage_version = "rhythm@beat_this-final0-1"

    def __init__(self, device: str = "cpu") -> None:
        """Loads and hash-verifies the pinned checkpoint.

        Raises:
            BeatThisUnavailableError: no checkpoint, no ``ml`` extra, or a hash mismatch.
        """
        path = checkpoint_path()
        if path is None or not path.is_file():
            raise BeatThisUnavailableError(f"{CHECKPOINT_ENV} does not point at a checkpoint file")
        actual = _sha256(path)
        if actual != CHECKPOINT_SHA256:
            raise BeatThisUnavailableError(
                f"checkpoint hash {actual} does not match the pin in MODELS.md"
            )
        try:
            from beat_this.inference import Audio2Beats
        except ImportError as error:
            raise BeatThisUnavailableError(
                "beat_this is not installed (install bragi-analysis with the `ml` extra)"
            ) from error
        self._model: Any = Audio2Beats(checkpoint_path=str(path), device=device, dbn=False)

    def track(self, mono: NDArray[np.float32], sample_rate: int) -> BeatEstimate:
        """Beats and downbeats in seconds."""
        beats, downbeats = self._model(mono, sample_rate)
        return BeatEstimate(
            beats=np.asarray(beats, dtype=np.float64),
            downbeats=np.asarray(downbeats, dtype=np.float64),
        )
