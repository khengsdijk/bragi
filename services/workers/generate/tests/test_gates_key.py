"""Step 3: key check, relative keys and the ±1 semitone repair (09 §6)."""

from __future__ import annotations

from dataclasses import replace

import numpy as np
import pytest
from gates_support import chord_pad, request, song

from bragi_generate.postprocess import tonality
from bragi_generate.postprocess.config import GateConfig
from bragi_generate.postprocess.types import Audio

CFG = GateConfig()


def test_same_key_passes_untouched() -> None:
    result = tonality.check(chord_pad(0, "major", 6.0), request(120.0), CFG)
    assert result.verdict.passed
    assert result.match.relation == "same"
    assert result.match.detected.label == "C major"
    assert result.match.shift_semitones == 0
    assert result.audio.frames == chord_pad(0, "major", 6.0).frames


def test_relative_key_passes() -> None:
    result = tonality.check(chord_pad(9, "minor", 6.0), request(120.0), CFG)
    assert result.verdict.passed
    assert result.match.relation == "relative"


def test_same_tonic_other_mode_is_rejected() -> None:
    result = tonality.check(chord_pad(0, "minor", 6.0), request(120.0), CFG)
    assert not result.verdict.passed
    assert result.match.relation == "off"


def test_tritone_is_rejected() -> None:
    result = tonality.check(chord_pad(6, "major", 6.0), request(120.0), CFG)
    assert not result.verdict.passed
    assert result.match.relation == "off"
    assert result.audio.frames == chord_pad(6, "major", 6.0).frames


def test_two_semitones_are_rejected_even_though_close() -> None:
    result = tonality.check(chord_pad(2, "major", 6.0), request(120.0), CFG)
    assert not result.verdict.passed


@pytest.mark.parametrize(("transpose", "shift"), [(1, -1), (-1, 1)])
def test_one_semitone_is_repaired(transpose: int, shift: int) -> None:
    result = tonality.check(chord_pad(0, "major", 6.0, transpose=transpose), request(120.0), CFG)
    assert result.verdict.passed
    assert result.match.relation == "shifted"
    assert result.match.shift_semitones == shift
    assert result.verdict.metrics["key_after_shift"] == "C major"
    assert result.audio.frames == chord_pad(0, "major", 6.0).frames


def test_relative_keys_can_be_turned_off() -> None:
    result = tonality.check(
        chord_pad(9, "minor", 6.0), request(120.0), replace(CFG, allow_relative_key=False)
    )
    assert not result.verdict.passed


def test_drums_plus_pad_are_read_as_the_pad_key() -> None:
    result = tonality.check(song(120.0, 8.0), request(120.0), CFG)
    assert result.verdict.passed
    assert result.match.detected.label == "C major"


def test_detection_of_silence_is_not_confident() -> None:
    silence = Audio(np.zeros((48_000, 2), dtype=np.float32), 48_000)
    key, confidence = tonality.detect(silence)
    assert confidence == 0.0
    assert key.label in {"C major", "C minor"}
