"""The pinned LAION-CLAP embedder (``specs/04`` §6.1, [ADR-0011]).

The v1 target is ``laion/larger_clap_music`` (512-d, Apache-2.0 weights, MIT ``laion_clap``
code). Weights are **never** downloaded at runtime (04 §9): this loader reads a checkpoint
directory from ``BRAGI_CLAP_CHECKPOINT`` (or ``BRAGI_MODELS_DIR/clap``), verifies the SHA-256 of
its weights file against the pin, and only then imports ``torch``/``transformers`` lazily (they
live in the optional ``clap`` extra, so the CPU gate never needs them).

The exact bytes and the pinned commit could not be fetched in this environment, so the SHA-256
is a placeholder and :meth:`load` refuses to run until the owner records it in
``services/workers/MODELS.md``. Nothing here has been exercised with real weights.
"""

from __future__ import annotations

import os
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import numpy as np
from numpy.typing import NDArray

from bragi_analysis.embedding import windows
from bragi_analysis.embedding.protocol import CLAP_MODEL, EmbedderUnavailableError

type F64 = NDArray[np.float64]

#: The Hugging Face repository and the checkpoint files the pin covers.
CLAP_REPO = "laion/larger_clap_music"
CLAP_WEIGHTS_FILE = "model.safetensors"
#: Owner actions: the pinned commit and the weights SHA-256 (MODELS.md). Empty here.
CLAP_REVISION = "main"
CLAP_SHA256 = ""
#: LAION-CLAP models resample to this rate internally (04 §6.1 uses the working 48 kHz too).
CLAP_RATE = 48_000


def sha256_file(path: Path) -> str:
    """The SHA-256 of a file, read in chunks."""
    import hashlib

    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _checkpoint_dir() -> Path | None:
    explicit = os.environ.get("BRAGI_CLAP_CHECKPOINT")
    if explicit:
        return Path(explicit)
    models_dir = os.environ.get("BRAGI_MODELS_DIR")
    if models_dir:
        return Path(models_dir) / "clap"
    return None


class CLAPEmbedder:
    """The joint audio-text embedder (04 §6.1); see the module docstring."""

    def __init__(self, model: Any, processor: Any, device: str) -> None:  # noqa: ANN401
        """Wraps a loaded ``ClapModel``, its processor and the torch device (both untyped)."""
        self._model = model
        self._processor = processor
        self._device = device

    @classmethod
    def available(cls) -> bool:
        """True when a checkpoint directory is configured and present (not that it verifies)."""
        directory = _checkpoint_dir()
        return directory is not None and directory.is_dir()

    @classmethod
    def load(cls) -> CLAPEmbedder:
        """Loads and verifies the pinned checkpoint, or raises :class:`EmbedderUnavailableError`."""
        directory = _checkpoint_dir()
        if directory is None:
            raise EmbedderUnavailableError(
                "no CLAP checkpoint: set BRAGI_CLAP_CHECKPOINT or BRAGI_MODELS_DIR (see MODELS.md)"
            )
        if not directory.is_dir():
            raise EmbedderUnavailableError(f"CLAP checkpoint directory {directory} does not exist")
        weights = directory / CLAP_WEIGHTS_FILE
        if not weights.is_file():
            raise EmbedderUnavailableError(f"{weights} is missing")
        digest = os.environ.get("BRAGI_CLAP_SHA256") or CLAP_SHA256
        if not digest:
            raise EmbedderUnavailableError(
                "the CLAP checkpoint SHA-256 is not pinned yet; record it in MODELS.md and set "
                "BRAGI_CLAP_SHA256 (04 §9)"
            )
        if sha256_file(weights) != digest:
            raise EmbedderUnavailableError(f"{weights} does not match the pinned SHA-256")
        try:
            import torch
            from transformers import ClapModel, ClapProcessor
        except ImportError as error:  # pragma: no cover - the extra is absent in the CPU gate
            raise EmbedderUnavailableError(
                "CLAP needs the 'clap' extra (torch + transformers); "
                "run `uv sync --directory services/workers --extra clap`"
            ) from error
        device = "cuda" if torch.cuda.is_available() else "cpu"
        model = ClapModel.from_pretrained(str(directory)).to(device).eval()
        processor = ClapProcessor.from_pretrained(str(directory))
        return cls(model, processor, device)

    @property
    def model(self) -> str:
        """The model id recorded in the blob."""
        return CLAP_MODEL

    @property
    def dim(self) -> int:
        """The vector length (512 for the v1 checkpoints)."""
        return windows.DIM

    def window_vectors(self, mono: NDArray[np.floating], sample_rate: int) -> list[F64]:
        """One CLAP audio feature per 10 s/5 s window, L2-normalised (04 §6.1)."""
        from fractions import Fraction

        from scipy.signal import resample_poly

        if sample_rate == CLAP_RATE:
            resampled = mono.astype(np.float32)
        else:
            ratio = Fraction(CLAP_RATE, sample_rate)
            resampled = np.asarray(
                resample_poly(
                    mono.astype(np.float32),
                    ratio.numerator,
                    ratio.denominator,
                    window=("kaiser", 9.0),
                ),
                dtype=np.float32,
            )
        duration = resampled.shape[0] / CLAP_RATE
        out: list[F64] = []
        for start, end in windows.window_spans(duration):
            segment = resampled[int(start * CLAP_RATE) : int(end * CLAP_RATE)]
            out.append(self._audio_feature(segment))
        return out

    def _audio_feature(self, segment: NDArray[np.float32]) -> F64:
        import torch

        inputs = self._processor(audios=segment, sampling_rate=CLAP_RATE, return_tensors="pt")
        inputs = {key: value.to(self._device) for key, value in inputs.items()}
        with torch.no_grad():
            features = self._model.get_audio_features(**inputs)
        vector = features.detach().cpu().numpy().reshape(-1).astype(np.float64)
        return windows.unit(vector)

    def embed_texts(self, texts: Sequence[str]) -> F64:
        """One CLAP text feature per text, L2-normalised."""
        import torch

        inputs = self._processor(text=list(texts), return_tensors="pt", padding=True)
        inputs = {key: value.to(self._device) for key, value in inputs.items()}
        with torch.no_grad():
            features = self._model.get_text_features(**inputs)
        matrix = features.detach().cpu().numpy().astype(np.float64)
        return np.asarray(
            [windows.unit(row) for row in matrix.reshape(len(texts), -1)], dtype=np.float64
        )


__all__ = ["CLAP_RATE", "CLAP_REPO", "CLAPEmbedder", "sha256_file"]
