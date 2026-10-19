"""``rhythm``: post-processing, the DSP tracker, and the capability (WP-1.2)."""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import cast

import numpy as np
import pytest
from analysis_support import FakeContext, make_job, needs_ffmpeg, wav_bytes

from bragi_analysis import rhythm_post
from bragi_analysis.capabilities import rhythm
from bragi_analysis.evaluation import metrics, synthetic
from bragi_analysis.trackers import beat_this, select
from bragi_analysis.trackers.dsp import DspTracker
from bragi_common.context import JobContext


def grid(bpm: float, count: int, start: float = 0.5) -> np.ndarray:
    return start + np.arange(count) * 60.0 / bpm


# --- post-processing -----------------------------------------------------------------------


def test_a_steady_grid_is_stable_with_the_exact_bpm() -> None:
    beats = grid(123.0, 64)
    result = rhythm_post.build_result(beats, beats[::4], 32.0)
    assert result.bpm == pytest.approx(123.0, abs=0.01)
    assert result.isTempoStable is True
    assert result.timeSignature.numerator == 4
    assert result.timeSignature.denominator.value == 4
    assert len(result.tempoCurve) == 64
    assert all(p.bpm == pytest.approx(123.0, abs=0.01) for p in result.tempoCurve)
    assert result.confidence > 0.9
    assert result.lowConfidence is False
    assert result.alternativeBpm == pytest.approx(246.0, abs=0.01)  # below 125 bpm: the double


def test_a_frame_quantised_grid_still_gives_the_true_bpm() -> None:
    # Beat This! reports beats on a 20 ms frame grid; the median IBI would say 125, the fit 123.
    beats = np.round(grid(123.0, 120) / 0.02) * 0.02
    result = rhythm_post.build_result(beats, beats[::4], 70.0)
    assert result.bpm == pytest.approx(123.0, abs=0.3)


@pytest.mark.parametrize(
    ("tracked", "reported", "alternative"),
    [(60.0, 120.0, 60.0), (200.0, 100.0, 200.0), (150.0, 150.0, 75.0), (90.0, 90.0, 180.0)],
)
def test_bpm_is_folded_into_70_to_180_and_the_grid_follows(
    tracked: float, reported: float, alternative: float
) -> None:
    beats = grid(tracked, 96)
    result = rhythm_post.build_result(beats, beats[::4], 90.0)
    assert result.bpm == pytest.approx(reported, abs=0.05)
    assert 70.0 <= result.bpm <= 180.0
    assert result.alternativeBpm == pytest.approx(alternative, abs=0.05)
    # The published beats describe the same pulse as the published bpm.
    spacing = float(np.median(np.diff(np.asarray(result.beats))))
    assert 60.0 / spacing == pytest.approx(reported, abs=0.05)


def test_halving_keeps_the_downbeats_on_the_grid() -> None:
    beats = grid(200.0, 96)
    downbeats = beats[1::8]  # downbeats on odd beats: the wrong parity for a naive [::2]
    result = rhythm_post.build_result(beats, downbeats, 60.0)
    published = np.asarray(result.beats)
    for downbeat in np.asarray(result.downbeats):
        assert np.min(np.abs(published - downbeat)) < 1e-3


@pytest.mark.parametrize(("per_bar", "expected"), [(2, 2), (3, 3), (4, 4), (5, 5), (7, 7)])
def test_time_signature_comes_from_the_downbeat_spacing(per_bar: int, expected: int) -> None:
    beats = grid(120.0, 80)
    result = rhythm_post.build_result(beats, beats[::per_bar], 45.0)
    assert result.timeSignature.numerator == expected


def test_a_drifting_tempo_is_not_stable_and_the_curve_follows_it() -> None:
    periods = 0.5 - 0.004 * np.arange(80)  # speeds up by roughly 0.8 % per beat
    beats = 0.5 + np.concatenate([[0.0], np.cumsum(periods)])
    result = rhythm_post.build_result(beats, beats[::4], 30.0)
    curve = [p.bpm for p in result.tempoCurve]
    assert result.isTempoStable is False
    assert curve[-5] > curve[5] * 1.2


def test_irregular_beats_are_low_confidence() -> None:
    rng = np.random.default_rng(0)
    beats = np.cumsum(rng.uniform(0.25, 1.0, 80))  # rubato: no steady pulse
    result = rhythm_post.build_result(beats, beats[::4], float(beats[-1]) + 1)
    assert result.confidence < 0.4
    assert result.lowConfidence is True


def test_no_beats_is_a_flagged_result_not_a_failure() -> None:
    result = rhythm_post.build_result(np.zeros(0), np.zeros(0), 10.0)
    assert result.beats == []
    assert result.downbeats == []
    assert result.tempoCurve == []
    assert result.confidence == 0.0
    assert result.lowConfidence is True
    assert result.bpm > 0


def test_the_result_validates_against_the_generated_schema_model() -> None:
    beats = grid(100.0, 40)
    result = rhythm_post.build_result(beats, beats[::4], 25.0)
    again = type(result).model_validate_json(result.model_dump_json(exclude_none=True))
    assert again == result


# --- the DSP tracker -----------------------------------------------------------------------


@pytest.mark.parametrize("bpm", [75, 100, 120, 140])
def test_dsp_tracker_finds_click_track_beats(bpm: int) -> None:
    track = synthetic.click_track(bpm, 40)
    estimate = DspTracker().track(track.audio, track.sample_rate)
    assert metrics.beat_f_measure(track.beats, estimate.beats) >= 0.95
    assert metrics.beat_f_measure(track.downbeats, estimate.downbeats) >= 0.9


def test_dsp_tracker_follows_a_tempo_ramp_and_noise() -> None:
    ramp = synthetic.click_track(110, 40, drift_per_beat=0.0008)
    noisy = synthetic.click_track(128, 40, noise_db=-30)
    for track in (ramp, noisy):
        estimate = DspTracker().track(track.audio, track.sample_rate)
        assert metrics.beat_f_measure(track.beats, estimate.beats) >= 0.95


def test_dsp_tracker_returns_nothing_for_silence_and_for_a_clip_too_short() -> None:
    silence = DspTracker().track(np.zeros(22_050 * 10, dtype=np.float32), 22_050)
    short = DspTracker().track(np.ones(1000, dtype=np.float32), 22_050)
    assert silence.beats.size == 0
    assert short.beats.size == 0


# --- selection and the weights guard -------------------------------------------------------


def test_auto_falls_back_to_dsp_without_weights(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(beat_this.CHECKPOINT_ENV, raising=False)
    assert select("auto").name == "dsp"
    assert select("dsp").name == "dsp"
    with pytest.raises(beat_this.BeatThisUnavailableError):
        select("beat_this")


def test_a_checkpoint_with_the_wrong_hash_is_refused(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    fake = tmp_path / "final0.ckpt"
    fake.write_bytes(b"not the pinned weights")
    monkeypatch.setenv(beat_this.CHECKPOINT_ENV, str(fake))
    with pytest.raises(beat_this.BeatThisUnavailableError, match="does not match the pin"):
        beat_this.BeatThisTracker()


# --- the capability ------------------------------------------------------------------------


@needs_ffmpeg
def test_capability_publishes_a_rhythm_blob(tmp_path: Path) -> None:
    track = synthetic.click_track(120, 30, sample_rate=44_100)
    context = FakeContext(tmp_path, wav_bytes(track.audio, 44_100))
    outputs = asyncio.run(
        rhythm.run(make_job("analysis.rhythm", {"tracker": "dsp"}), cast(JobContext, context))
    )
    assert outputs.blobs is not None
    blob = json.loads(context.uploads[outputs.blobs["result"]])
    assert blob["schemaVersion"] == 1
    assert blob["bpm"] == pytest.approx(120.0, abs=0.5)
    assert blob["timeSignature"] == {"numerator": 4, "denominator": 4}
    assert metrics.beat_f_measure(track.beats, np.asarray(blob["beats"])) >= 0.95
    assert context.reports[-1] == 1.0


def test_capability_names_follow_the_orchestrator_dag() -> None:
    from bragi_analysis.capabilities import ingest, loudness_energy

    assert (ingest.CAPABILITY, rhythm.CAPABILITY, loudness_energy.CAPABILITY) == (
        "analysis.ingest",
        "analysis.rhythm",
        "analysis.loudness_energy",
    )
    with pytest.raises(ValueError, match="tracker"):
        rhythm.ParamsModel.model_validate({"tracker": "madmom"})


# --- real weights (skipped by default: 04 §9, 13 §3) ---------------------------------------

weights = pytest.mark.skipif(
    os.environ.get("BRAGI_TEST_WEIGHTS") != "1" or not beat_this.is_available(),
    reason="needs the pinned Beat This! weights: set BRAGI_TEST_WEIGHTS=1 and "
    f"{beat_this.CHECKPOINT_ENV} (MODELS.md)",
)


@weights
def test_beat_this_tracks_a_click_track_on_cpu() -> None:
    track = synthetic.click_track(120, 40)
    estimate = beat_this.BeatThisTracker().track(track.audio, track.sample_rate)
    assert metrics.beat_f_measure(track.beats, estimate.beats) >= 0.9
