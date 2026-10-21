"""Step 2: tempo conform, half/double time and the WSOLA warp (09 §6)."""

from __future__ import annotations

import numpy as np
import pytest
from gates_support import click_track, drum_pattern, metric, request, song

from bragi_generate.postprocess import tempo, tonality
from bragi_generate.postprocess.config import GateConfig
from bragi_generate.postprocess.stretch import pitch_shift, time_stretch
from bragi_generate.postprocess.types import Audio

CFG = GateConfig()


def test_exact_tempo_passes_with_only_a_residual_correction() -> None:
    original = drum_pattern(120.0, 8.0)
    result = tempo.conform(original, request(120.0), CFG)
    assert result.verdict.passed
    assert result.multiple == 1.0
    assert metric(result.verdict, "tempo_error") < 0.01
    assert result.audio.duration_sec == pytest.approx(original.duration_sec, rel=0.002)


@pytest.mark.parametrize("bpm", [60.0, 240.0])
def test_half_and_double_time_are_accepted(bpm: float) -> None:
    result = tempo.conform(click_track(bpm, 8.0), request(120.0), CFG)
    assert result.verdict.passed
    assert metric(result.verdict, "tempo_error") < 0.04
    assert result.multiple in {0.5, 1.0, 2.0}


def test_eight_percent_off_is_rejected() -> None:
    result = tempo.conform(drum_pattern(129.6, 8.0), request(120.0), CFG)
    assert not result.verdict.passed
    assert metric(result.verdict, "tempo_error") > 0.04
    assert result.audio.frames == drum_pattern(129.6, 8.0).frames


def test_quarter_off_is_rejected() -> None:
    result = tempo.conform(drum_pattern(90.0, 8.0), request(120.0), CFG)
    assert not result.verdict.passed


def test_warp_lands_on_the_requested_tempo() -> None:
    result = tempo.conform(drum_pattern(123.5, 8.0), request(120.0), CFG)
    assert result.verdict.passed
    assert metric(result.verdict, "tempo_error") < 0.04
    stretch = float(result.verdict.metrics["stretch"])
    assert result.audio.duration_sec == pytest.approx(8.0 * stretch, rel=0.001)
    measured, _ = tempo.beat_times(result.audio)
    assert measured == pytest.approx(120.0, rel=0.005)
    # Beat times are rescaled with the audio, so they still index the output.
    assert np.all(np.diff(result.beats_sec) > 0.0)
    assert result.beats_sec[-1] < result.audio.duration_sec


def test_a_sub_percent_stretch_keeps_a_tonal_song_in_its_key() -> None:
    """Regression: the WSOLA search used to start one hop late and mangle the chroma."""
    before = song(120.0, 8.0, root_pc=9, mode="minor")
    stretched = Audio(time_stretch(before.samples, 1.0007, 48_000), 48_000)
    assert tonality.detect(stretched)[0] == tonality.detect(before)[0]


def test_stretch_factor_is_linear_in_length() -> None:
    stretched = time_stretch(click_track(120.0, 2.0).samples, 1.25, 48_000)
    assert stretched.shape[0] == pytest.approx(96_000 * 1.25, abs=1)


def test_pitch_shift_keeps_the_duration() -> None:
    shifted = pitch_shift(click_track(120.0, 2.0).samples, 1.0, 48_000)
    assert shifted.shape[0] == 96_000
