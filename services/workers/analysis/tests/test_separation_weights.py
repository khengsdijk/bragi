"""Pinned weights: the lock file, MODELS.md and (optionally) the real model."""

from __future__ import annotations

import os
from pathlib import Path

import numpy as np
import pytest

from bragi_analysis.separation import pipeline as pl
from bragi_analysis.separation.audio import decode_flac, encode_flac
from bragi_analysis.separation.weights import (
    WeightsError,
    load_lock,
    pin_for,
    sha256_file,
    verified_model_dir,
)

MODELS_MD = Path(__file__).resolve().parents[2] / "MODELS.md"


def test_every_pinned_hash_is_recorded_in_models_md() -> None:
    text = MODELS_MD.read_text(encoding="utf-8")
    for name, pin in load_lock().items():
        assert f"`{name}`" in text, f"{name} is pinned but not in MODELS.md"
        assert pin.revision in text, f"{name}: revision {pin.revision} not in MODELS.md"
        for filename, digest in pin.files.items():
            assert digest in text, f"{name}/{filename}: sha256 not in MODELS.md"


def test_the_v1_default_is_pinned_with_a_stage_version() -> None:
    assert pin_for("htdemucs_6s").stage_version == "htdemucs_6s-1"
    with pytest.raises(WeightsError, match="unknown"):
        pin_for("not_a_model")


def test_missing_and_tampered_weights_are_refused(tmp_path: Path) -> None:
    with pytest.raises(WeightsError, match="missing"):
        verified_model_dir(tmp_path, "htdemucs_6s")
    directory = tmp_path / "htdemucs_6s"
    directory.mkdir()
    for filename in pin_for("htdemucs_6s").files:
        (directory / filename).write_bytes(b"tampered")
    with pytest.raises(WeightsError, match="does not match"):
        verified_model_dir(tmp_path, "htdemucs_6s")
    assert (
        sha256_file(directory / "htdemucs_6s.yaml")
        != pin_for("htdemucs_6s").files["htdemucs_6s.yaml"]
    )


@pytest.mark.weights
def test_real_htdemucs_6s_separates_and_nulls() -> None:
    """Needs ``BRAGI_MODELS_DIR`` and ``uv sync --group models``; ~10 s on a laptop CPU."""
    from bragi_analysis.separation.demucs_backend import DemucsBackend

    backend = DemucsBackend.load(
        "htdemucs_6s", device="cpu", root=Path(os.environ["BRAGI_MODELS_DIR"])
    )
    assert list(backend.stem_names) == ["drums", "bass", "other", "vocals", "guitar", "piano"]
    assert backend.sample_rate == 44_100 and backend.max_segment_sec == pytest.approx(7.8)

    n = 12 * 48_000
    t = np.arange(n) / 48_000
    kick = np.sin(2 * np.pi * 60 * t) * np.exp(-((t * 2) % 1.0) * 12)
    raw = 0.4 * np.stack([kick + 0.3 * np.sin(2 * np.pi * 440 * t)] * 2)
    mix, _ = decode_flac(encode_flac(raw, 48_000))

    x = pl.resample(mix, 48_000, 44_100).astype(np.float32)
    chunks = pl.plan_chunks(x.shape[-1], int(7.8 * 44_100), 44_100)
    stitcher = pl.Stitcher(6, 2, x.shape[-1], chunks)
    for index, chunk in enumerate(chunks):
        stitcher.add(index, backend.separate(x[:, chunk.start : chunk.end]))
    stems = stitcher.finish()
    assert stems.shape[0] == 6 and np.isfinite(stems).all()

    accumulator = pl.ResidualAccumulator(mix)
    stored = []
    for stem in stems:
        audio = pl.clip_full_scale(
            pl.fit_length(pl.resample(stem.astype(np.float64), 44_100, 48_000), n)
        )
        decoded, _ = decode_flac(encode_flac(audio, 48_000))
        accumulator.add(decoded)
        stored.append(decoded)
    residual, _ = decode_flac(encode_flac(pl.clip_full_scale(accumulator.residual()), 48_000))
    rms, _ = pl.null_db(mix, stored, residual)
    assert rms <= -60.0
