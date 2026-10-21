"""Step 5/7: seam score, equal-power crossfade, phase offset and splice search."""

from __future__ import annotations

from dataclasses import replace

import numpy as np
from gates_support import SAMPLE_RATE, audio, request

from bragi_generate.postprocess import seam
from bragi_generate.postprocess.config import GateConfig

CFG = GateConfig()


def _noise(seconds: float, level: float, seed: int, channels: int = 2) -> np.ndarray:
    rng = np.random.default_rng(seed)
    shape = (round(seconds * SAMPLE_RATE), channels)
    return np.asarray(rng.standard_normal(shape) * level, dtype=np.float32)


def test_crossfade_is_equal_power_on_uncorrelated_noise() -> None:
    before = _noise(1.0, 0.1, 1)
    after = _noise(1.0, 0.1, 2)
    mixed = seam.crossfade(before, after, before.shape[0])
    window = 2400  # 50 ms
    rms = np.asarray(
        [
            float(np.sqrt(np.mean(mixed[start : start + window] ** 2)))
            for start in range(0, 48_000, window)
        ]
    )
    deviation_db = 20.0 * np.log10(rms / float(np.median(rms)))
    assert np.max(np.abs(deviation_db)) < 0.5


def test_crossfade_shape_squares_to_one() -> None:
    fade_out, fade_in = seam.crossfade_shape(1024)
    assert np.allclose(fade_out**2 + fade_in**2, 1.0, atol=1e-6)
    assert fade_in[0] < 0.01
    assert fade_in[-1] > 0.99


def test_phase_offset_finds_the_least_cancelling_alignment() -> None:
    length = 4000
    limit = 96
    time = np.arange(length + 2 * limit) / SAMPLE_RATE
    signal = np.asarray(np.sin(2 * np.pi * 200.0 * time), dtype=np.float32)[:, None]
    reference = signal[limit : limit + length]
    assert seam.phase_offset(reference, signal, length, limit) == 0

    delayed = np.concatenate([np.zeros((3, 1), np.float32), signal])[: signal.shape[0]]
    assert seam.phase_offset(reference, delayed, length, limit) == 3

    advanced = np.concatenate([signal[limit:], np.zeros((limit, 1), np.float32)])
    assert seam.phase_offset(reference, advanced, length, limit) == -limit


def test_phase_offset_prefers_no_shift_without_signal() -> None:
    silence = np.zeros((1000, 1), np.float32)
    assert seam.phase_offset(silence, silence, 500, 20) == 0


def test_seam_score_rises_with_a_loudness_step() -> None:
    rng = np.random.default_rng(4)
    render = np.zeros((2 * SAMPLE_RATE, 2), np.float32)
    render[:SAMPLE_RATE] = rng.standard_normal((SAMPLE_RATE, 2)).astype(np.float32) * 0.05
    render[SAMPLE_RATE:] = rng.standard_normal((SAMPLE_RATE, 2)).astype(np.float32) * 0.2
    step = seam.seam_score(render, SAMPLE_RATE, SAMPLE_RATE, CFG)

    flat = seam.seam_score(_noise(2.0, 0.05, 4), SAMPLE_RATE, SAMPLE_RATE, CFG)

    assert step.total > flat.total
    assert step.loudness_jump > 10.0
    assert flat.loudness_jump < 1.0


def test_seam_score_rejects_a_window_that_does_not_fit() -> None:
    render = np.zeros((SAMPLE_RATE, 2), np.float32)
    assert seam.seam_score(render, 10, SAMPLE_RATE, CFG).total == float("inf")


def test_splice_search_picks_the_planted_beat() -> None:
    # A level step at the planted beat: every earlier seam starts a window inside the
    # loud region, so only the planted beat produces a low loudness jump.
    config = replace(CFG, crossfade_beats=0.1)
    context = audio(_noise(4.0, 0.08, 9))
    candidate = audio(_noise(5.0, 0.08, 10))
    planted = round(3.5 * SAMPLE_RATE)
    candidate.samples[:planted] *= 5.0
    beats = np.arange(0, round(4.0 * SAMPLE_RATE), 24_000, dtype=np.int64)

    search = seam.splice_search(context, candidate, beats, request(120.0), config)
    assert search.verdict.passed
    assert search.result is not None
    assert search.result.position == planted
    assert search.result.positions == tuple(range(24_000, 4 * SAMPLE_RATE, 24_000))


def test_splice_search_rejects_a_candidate_above_the_threshold() -> None:
    config = replace(CFG, crossfade_beats=0.1)
    context = audio(_noise(4.0, 0.08, 11))
    candidate = audio(_noise(5.0, 0.08, 12))
    candidate.samples[:] *= 5.0
    beats = np.arange(0, round(4.0 * SAMPLE_RATE), 24_000, dtype=np.int64)
    search = seam.splice_search(context, candidate, beats, request(120.0), config)
    assert not search.verdict.passed
    assert search.result is not None


def test_splice_search_needs_a_position() -> None:
    config = replace(CFG, crossfade_beats=0.1)
    context = audio(_noise(4.0, 0.08, 13))
    candidate = audio(_noise(5.0, 0.08, 14))
    search = seam.splice_search(context, candidate, np.zeros(0, np.int64), request(120.0), config)
    assert not search.verdict.passed
    assert search.result is None
