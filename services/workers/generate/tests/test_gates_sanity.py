"""Step 1: silence, clipping and non-finite samples (09 §6)."""

from __future__ import annotations

import numpy as np
from gates_support import SAMPLE_RATE, audio, clipped, drum_pattern, metric

from bragi_generate.postprocess import sanity
from bragi_generate.postprocess.config import GateConfig


def test_clean_drums_pass() -> None:
    verdict = sanity.check(drum_pattern(120.0, 4.0), GateConfig())
    assert verdict.passed
    assert metric(verdict, "silent_fraction") < 0.5
    assert metric(verdict, "clipped_fraction") == 0.0


def test_silence_is_rejected() -> None:
    verdict = sanity.check(audio(np.zeros(SAMPLE_RATE * 2, dtype=np.float32)), GateConfig())
    assert not verdict.passed
    assert verdict.reason == "silent"
    assert metric(verdict, "silent_fraction") == 1.0


def test_half_silent_is_still_accepted_but_mostly_silent_is_not() -> None:
    half = drum_pattern(120.0, 4.0)
    padded = audio(np.concatenate([half.samples, np.zeros_like(half.samples)]))
    borderline = sanity.check(padded, GateConfig())
    assert metric(borderline, "silent_fraction") == 0.5
    assert borderline.passed

    almost = audio(np.concatenate([half.samples, np.zeros((half.frames * 3, 2), np.float32)]))
    verdict = sanity.check(almost, GateConfig())
    assert not verdict.passed
    assert metric(verdict, "silent_fraction") > 0.5


def test_clipping_is_rejected() -> None:
    verdict = sanity.check(clipped(drum_pattern(120.0, 4.0)), GateConfig())
    assert not verdict.passed
    assert verdict.reason == "clipped"
    assert metric(verdict, "clipped_fraction") > 0.001


def test_nan_is_rejected() -> None:
    samples = drum_pattern(120.0, 2.0).samples.copy()
    samples[100, 0] = np.nan
    verdict = sanity.check(audio(samples), GateConfig())
    assert not verdict.passed
    assert verdict.reason == "non-finite samples"
    assert metric(verdict, "nonfinite_samples") == 1


def test_infinity_is_rejected() -> None:
    samples = drum_pattern(120.0, 2.0).samples.copy()
    samples[10, 1] = np.inf
    verdict = sanity.check(audio(samples), GateConfig())
    assert not verdict.passed
    assert metric(verdict, "nonfinite_samples") == 1
