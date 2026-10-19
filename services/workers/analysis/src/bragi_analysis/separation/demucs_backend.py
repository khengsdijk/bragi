"""The HTDemucs backend: the only module in the worker that imports ``torch`` or ``demucs``.

Both are optional (the ``models`` dependency group), so the import is deferred to
:meth:`DemucsBackend.load`. Weights come from a local directory, verified against
``models_lock.json``; nothing is downloaded here (``specs/04`` §9).
"""

from __future__ import annotations

import os
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import numpy as np
import yaml
from numpy.typing import NDArray

from bragi_analysis.separation.weights import pin_for, verified_model_dir

#: Where the Docker build puts the weights (``Dockerfile``).
DEFAULT_MODELS_DIR = "/opt/bragi/models"


def models_dir() -> Path:
    """The weights root: ``BRAGI_MODELS_DIR`` or the image default."""
    return Path(os.environ.get("BRAGI_MODELS_DIR", DEFAULT_MODELS_DIR))


def pick_device(requested: str = "auto") -> str:
    """``cuda`` > ``mps`` > ``cpu`` for ``auto``; an explicit request is honoured as given."""
    import torch

    if requested != "auto":
        return requested
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


class DemucsBackend:
    """A loaded Demucs bag of models, applied one chunk at a time."""

    def __init__(self, bag: Any, device: str) -> None:  # noqa: ANN401 - demucs ships no stubs
        """Wraps an already-loaded ``BagOfModels`` (use :meth:`load`)."""
        self._bag = bag
        self._device = device

    @classmethod
    def load(cls, name: str, *, device: str = "auto", root: Path | None = None) -> DemucsBackend:
        """Loads ``name`` from the verified weights directory onto ``device``."""
        from demucs.apply import BagOfModels
        from demucs.hf import load_safetensors_model

        pin = pin_for(name)
        directory = verified_model_dir(root or models_dir(), name)
        bag_spec = yaml.safe_load((directory / pin.bag).read_text(encoding="utf-8"))
        models = [
            load_safetensors_model(directory / f"{signature}.safetensors")
            for signature in bag_spec["models"]
        ]
        bag = BagOfModels(models, bag_spec.get("weights"), bag_spec.get("segment"))
        bag.eval()
        return cls(bag, pick_device(device))

    @property
    def device(self) -> str:
        """The torch device inference runs on."""
        return self._device

    @property
    def sample_rate(self) -> int:
        """The model rate (44 100 Hz for HTDemucs)."""
        return int(self._bag.samplerate)

    @property
    def stem_names(self) -> Sequence[str]:
        """Stem names in output order."""
        return [str(source) for source in self._bag.sources]

    @property
    def max_segment_sec(self) -> float:
        """The longest chunk the transformer accepts (7.8 s for HTDemucs)."""
        return float(self._bag.max_allowed_segment)

    def separate(self, chunk: NDArray[np.float32]) -> NDArray[np.float32]:
        """Runs a ``(channels, n)`` chunk through the model into ``(stems, channels, n)``."""
        import torch
        from demucs.apply import apply_model

        with torch.inference_mode():
            tensor = torch.from_numpy(np.ascontiguousarray(chunk))[None]
            out = apply_model(
                self._bag,
                tensor,
                shifts=0,
                split=False,
                overlap=0.0,
                device=self._device,
                progress=False,
            )
        return np.asarray(out[0].cpu().numpy(), dtype=np.float32)
