"""Step 6: loudness ramp and the 31-band ``match_eq`` result (09 §6, 03 §8.2)."""

from __future__ import annotations

import numpy as np
import pytest
from gates_support import SAMPLE_RATE, audio, scale, song
from scipy import signal as scipy_signal

from bragi_generate.postprocess import match
from bragi_generate.postprocess.config import GateConfig

CFG = GateConfig()


def test_loud_candidate_is_pulled_down_to_the_context() -> None:
    context = song(120.0, 8.0)
    candidate = scale(song(120.0, 8.0), 4.0)
    result = match.loudness_match(candidate, context, CFG)
    assert result.head_gain_db < -10.0
    assert result.tail_gain_db < -10.0
    assert abs(match.measure(result.audio) - match.measure(context)) < 1.0


def test_gain_ramp_matches_the_head_and_the_tail() -> None:
    context = song(120.0, 8.0)
    candidate = scale(song(120.0, 8.0), 0.5)
    result = match.loudness_match(candidate, context, CFG)
    power = match.weighted_power(result.audio.samples, SAMPLE_RATE)
    window = 2 * SAMPLE_RATE
    target = match.measure(context)
    head = match.lufs(power, 0, window)
    tail = match.lufs(power, power.size - window, power.size)
    assert abs(head - target) < 0.5
    assert abs(tail - target) < 0.5
    assert result.head_gain_db > 3.0


def test_matched_candidate_gets_no_gain() -> None:
    signal = song(120.0, 8.0)
    result = match.loudness_match(signal, signal, CFG)
    assert abs(result.head_gain_db) < 0.2
    assert abs(result.tail_gain_db) < 0.2


def test_gain_is_clamped() -> None:
    context = song(120.0, 4.0)
    quiet = scale(song(120.0, 4.0), 0.0001)
    result = match.loudness_match(quiet, context, CFG)
    assert result.head_gain_db <= CFG.loudness_max_gain_db


def _lowpass(mono: np.ndarray, cutoff: float) -> np.ndarray:
    sos = scipy_signal.butter(4, cutoff, "low", fs=SAMPLE_RATE, output="sos")
    return np.asarray(scipy_signal.sosfilt(sos, mono), dtype=np.float32)


def test_spectral_match_is_31_bands_clamped_to_six_db() -> None:
    rng = np.random.default_rng(3)
    white = rng.standard_normal(6 * SAMPLE_RATE).astype(np.float32)
    dark = audio(_lowpass(white, 500.0) * 0.1)
    bright = audio((white - _lowpass(white, 500.0)) * 0.1)

    eq = match.spectral_match(dark, bright, CFG)
    assert len(eq.bands) == 31
    assert max(abs(band) for band in eq.bands) == CFG.eq_max_db
    assert min(eq.bands) <= -CFG.eq_max_db + 0.01
    assert eq.params()["amount"] == 1.0
    assert isinstance(eq.params()["bands"], list)


def test_spectral_match_of_identical_audio_is_flat() -> None:
    signal = song(120.0, 6.0)
    eq = match.spectral_match(signal, signal, CFG)
    assert all(abs(band) <= 0.5 for band in eq.bands)


def test_bands_span_the_thirty_one_iso_thirds() -> None:
    centres = match.band_centres(31)
    assert centres[0] == 20.0
    assert centres[-1] == pytest.approx(20000.0)
    assert np.all(np.diff(centres) > 0.0)
