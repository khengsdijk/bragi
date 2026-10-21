"""Gate configuration and the small value types (09 §6, 13 §3)."""

from __future__ import annotations

import tomllib
from dataclasses import fields
from pathlib import Path

import numpy as np
import pytest
from gates_support import SAMPLE_RATE, audio

from bragi_generate.postprocess import GateConfig, GateRequest, KeySpec, default_path
from bragi_generate.postprocess.types import Audio


def test_an_environment_override_wins(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    path = tmp_path / "gates.toml"
    path.write_text("[tempo]\nmax_error = 0.01\n", encoding="utf-8")
    monkeypatch.setenv("BRAGI_GENERATION_GATES", str(path))
    assert default_path() == path
    assert GateConfig.load().tempo_max_error == 0.01


def test_a_bad_environment_override_is_reported(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BRAGI_GENERATION_GATES", "/does/not/exist.toml")
    with pytest.raises(FileNotFoundError, match="BRAGI_GENERATION_GATES"):
        default_path()


def test_the_checked_in_config_is_found_from_the_package() -> None:
    path = default_path()
    assert path.is_file()
    assert path == Path(__file__).resolve().parents[4] / "config" / "generation_gates.toml"


def test_the_file_matches_the_dataclass_defaults() -> None:
    assert GateConfig.load() == GateConfig()


def test_every_config_value_is_present_in_the_file() -> None:
    raw = tomllib.loads(default_path().read_text("utf-8"))
    sections = {"sanity", "tempo", "key", "beat_align", "seam", "crossfade", "match"}
    assert sections <= raw.keys()
    names = {
        "silence_frame_sec",
        "silence_dbfs",
        "silence_fraction",
        "clip_level",
        "clip_fraction",
        "max_error",
        "allow_relative",
        "max_shift_semitones",
        "window_bars",
        "min_confidence",
        "search_beats",
        "window_sec",
        "flux_weight",
        "loudness_weight",
        "onset_weight",
        "max_score",
        "length_beats",
        "max_sec",
        "phase_search_sec",
        "loudness_window_sec",
        "max_gain_db",
        "eq_bands",
        "eq_max_db",
    }
    present = {key for section in raw.values() for key in section}
    assert names <= present
    assert len(fields(GateConfig)) == len(names)


def test_a_bad_value_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "gates.toml"
    path.write_text("[sanity]\nsilence_fraction = 0.0\n", encoding="utf-8")
    with pytest.raises(ValueError, match="silence_fraction"):
        GateConfig.load(path)


def test_missing_keys_fall_back_to_the_defaults(tmp_path: Path) -> None:
    path = tmp_path / "gates.toml"
    path.write_text("[tempo]\nmax_error = 0.02\n", encoding="utf-8")
    loaded = GateConfig.load(path)
    assert loaded.tempo_max_error == 0.02
    assert loaded.seam_max_score == GateConfig().seam_max_score


def test_request_derives_its_grid() -> None:
    req = GateRequest(bpm=120.0, time_signature=(4, 4), key=KeySpec(0, "major"), bars=4)
    assert req.beat_sec == 0.5
    assert req.bar_sec == 2.0
    assert req.overlap_sec == 4.0
    assert req.beats_per_bar == 4


def test_key_spec_parses_sharps_and_flats() -> None:
    assert KeySpec.parse("F#", "major") == KeySpec(6, "major")
    assert KeySpec.parse("Gb", "major") == KeySpec(6, "major")
    assert KeySpec.parse("Bb", "minor") == KeySpec(10, "minor")
    assert KeySpec(0, "major").label == "C major"


def test_key_spec_refuses_nonsense() -> None:
    with pytest.raises(ValueError, match="tonic"):
        KeySpec.parse("H", "major")
    with pytest.raises(ValueError, match="mode"):
        KeySpec.parse("C", "dorian")
    with pytest.raises(ValueError, match="tonic_pc"):
        KeySpec(12, "major")


def test_request_refuses_nonsense() -> None:
    with pytest.raises(ValueError, match="bpm"):
        GateRequest(bpm=0.0, time_signature=(4, 4), key=KeySpec(0, "major"), bars=1)
    with pytest.raises(ValueError, match="direction"):
        GateRequest(
            bpm=120.0,
            time_signature=(4, 4),
            key=KeySpec(0, "major"),
            bars=1,
            direction="sideways",  # type: ignore[arg-type]
        )


def test_audio_validates_and_mirrors() -> None:
    signal = audio(np.arange(SAMPLE_RATE * 2, dtype=np.float32))
    assert signal.frames == 2 * SAMPLE_RATE
    assert signal.duration_sec == 2.0
    assert np.array_equal(signal.reversed().reversed().samples, signal.samples)
    assert np.allclose(signal.mono, signal.samples[:, 0])
    with pytest.raises(ValueError, match="frames, channels"):
        Audio(np.zeros(SAMPLE_RATE, dtype=np.float32), SAMPLE_RATE)
    with pytest.raises(ValueError, match="float32"):
        Audio(np.zeros((SAMPLE_RATE, 1), dtype=np.float64), SAMPLE_RATE)
    with pytest.raises(ValueError, match="sample rate"):
        Audio(np.zeros((SAMPLE_RATE, 1), dtype=np.float32), 0)
