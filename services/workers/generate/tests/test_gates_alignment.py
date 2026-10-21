"""Step 4: beat-align lag recovery and confidence (09 §6, 03 §8.2)."""

from __future__ import annotations

import numpy as np
import pytest
from gates_support import SAMPLE_RATE, audio, drum_pattern, noisy, request
from numpy.typing import NDArray

from bragi_generate.postprocess import alignment
from bragi_generate.postprocess.config import GateConfig
from bragi_generate.postprocess.types import Audio

CFG = GateConfig()
HOP = 256


def _delayed(base: NDArray[np.float32], samples: int) -> Audio:
    """Delays (positive) or advances (negative) an audio array, zero-padded."""
    if samples >= 0:
        shifted = np.concatenate([np.zeros((samples, base.shape[1]), np.float32), base[:-samples]])
    else:
        shifted = np.concatenate([base[-samples:], np.zeros((-samples, base.shape[1]), np.float32)])
    return audio(shifted)


def test_known_shift_is_recovered_within_a_hop() -> None:
    song = drum_pattern(120.0, 20.0, seed=4)
    context = audio(song.samples[: 8 * SAMPLE_RATE])
    candidate = _delayed(song.samples[8 * SAMPLE_RATE : 16 * SAMPLE_RATE], 1024)
    result = alignment.beat_align(candidate, context, request(120.0), CFG)
    assert result.verdict.passed
    assert result.confidence > 0.9
    # The candidate's STFT boundary adds one frame of bias; one hop is the gate.
    assert abs(result.shift_samples - 1024) <= 2 * HOP
    assert result.verdict.metrics["shift_ms"] == pytest.approx(
        result.shift_samples / 48.0, abs=0.001
    )


def test_unaligned_candidate_has_low_confidence() -> None:
    context = drum_pattern(120.0, 8.0)
    candidate = noisy(drum_pattern(120.0, 8.0, seed=99), 0.5, seed=5)
    result = alignment.beat_align(candidate, context, request(120.0), CFG)
    assert not result.verdict.passed
    assert result.confidence < 0.5
    assert result.audio.frames == candidate.frames


def test_shift_is_applied_to_the_audio() -> None:
    song = drum_pattern(120.0, 16.0, seed=4)
    context = audio(song.samples[: 8 * SAMPLE_RATE])
    candidate = _delayed(song.samples[8 * SAMPLE_RATE :], 1024)
    result = alignment.beat_align(candidate, context, request(120.0), CFG)
    assert result.shift_samples > 0
    assert result.audio.frames == candidate.frames - result.shift_samples
