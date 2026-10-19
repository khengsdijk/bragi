"""``loudness_energy``: R128 numbers and the 04 §5.5 energy curve."""

from __future__ import annotations

import asyncio
import json
import math
import re
import subprocess
from pathlib import Path
from typing import cast

import numpy as np
import pytest
from analysis_support import FakeContext, make_job, needs_ffmpeg, sine, wav_bytes

from bragi_analysis.capabilities import loudness_energy
from bragi_analysis.dsp import energy, loudness
from bragi_common.context import JobContext

SR = 48_000


def db(level: float) -> float:
    return 10 ** (level / 20)


def stereo(mono: np.ndarray) -> np.ndarray:
    return np.stack([mono, mono], axis=1)


def test_ebu_tech_3341_sine_reads_minus_23_lufs() -> None:
    # EBU Tech 3341 test case 1: 997 Hz stereo sine at -23 dBFS -> -23.0 LUFS.
    tone = sine(20.0, SR, hz=997.0, amplitude=db(-23.0))
    result = loudness.measure(stereo(tone))
    assert result.integrated_lufs == pytest.approx(-23.0, abs=0.1)
    assert result.true_peak_db == pytest.approx(-23.0, abs=0.1)
    assert result.lra == pytest.approx(0.0, abs=0.05)


def test_a_single_channel_sine_is_three_db_quieter_than_dual() -> None:
    tone = sine(10.0, SR, hz=997.0, amplitude=db(-20.0))
    dual = loudness.measure(stereo(tone)).integrated_lufs
    single = loudness.measure(np.stack([tone, np.zeros_like(tone)], axis=1)).integrated_lufs
    assert dual - single == pytest.approx(3.01, abs=0.05)


def test_true_peak_sees_an_inter_sample_peak_the_samples_miss() -> None:
    # A sine at fs/4 sampled 45 degrees off the crest has sample peak 0.707 and true peak 1.0.
    n = np.arange(SR)
    x = (np.sin(2 * np.pi * n / 4 + math.pi / 4)).astype(np.float32)
    sample_peak_db = 20 * math.log10(float(np.max(np.abs(x))))
    assert sample_peak_db == pytest.approx(-3.01, abs=0.05)
    assert loudness.true_peak_db(stereo(x)) == pytest.approx(0.0, abs=0.15)


def test_loudness_range_of_two_levels_equals_their_difference() -> None:
    loud = sine(30.0, SR, hz=997.0, amplitude=db(-20.0))
    quiet = sine(30.0, SR, hz=997.0, amplitude=db(-30.0))
    result = loudness.measure(stereo(np.concatenate([loud, quiet])))
    # P95 sits in the loud half and P10 in the quiet half; transitions only widen it slightly.
    assert result.lra == pytest.approx(10.0, abs=0.7)


def test_silence_is_floored_not_minus_infinity() -> None:
    result = loudness.measure(np.zeros((SR * 3, 2), dtype=np.float32))
    assert result.integrated_lufs == loudness.FLOOR_LUFS
    assert result.true_peak_db == loudness.FLOOR_DB
    assert np.all(result.short_term_lufs == loudness.FLOOR_LUFS)


def test_short_term_series_has_one_value_per_hop_and_follows_the_level() -> None:
    quiet = sine(8.0, SR, hz=440.0, amplitude=db(-40.0))
    loud = sine(8.0, SR, hz=440.0, amplitude=db(-14.0))
    series = loudness.measure(stereo(np.concatenate([quiet, loud]))).short_term_lufs
    assert series.shape[0] == math.ceil(16.0 / 0.5)
    assert series[2] < series[-3] - 20  # 8 s into each half the 3 s window is pure
    assert np.all(series >= loudness.FLOOR_LUFS)


def test_a_clip_shorter_than_a_gating_block_still_measures() -> None:
    tone = sine(0.3, SR, hz=997.0, amplitude=db(-23.0))
    result = loudness.measure(stereo(tone))
    assert result.integrated_lufs == pytest.approx(-23.0, abs=0.3)
    assert result.short_term_lufs.shape[0] == 1


def drum_loop(seconds: float, level_db: float) -> np.ndarray:
    """Noise bursts every 0.5 s over a low sine: a stand-in for a busy section."""
    rng = np.random.default_rng(7)
    out = np.zeros(round(seconds * SR), dtype=np.float32)
    burst = (rng.uniform(-1, 1, 2400) * np.exp(-np.arange(2400) / 500)).astype(np.float32)
    for start in range(0, out.shape[0] - 2400, SR // 2):
        out[start : start + 2400] += burst
    out += 0.3 * sine(seconds, SR, hz=80.0)[: out.shape[0]]
    return out * db(level_db)


def test_energy_curve_has_the_documented_hop_and_range() -> None:
    quiet = sine(10.0, SR, hz=220.0, amplitude=db(-40.0))
    busy = drum_loop(10.0, -6.0)
    audio = stereo(np.concatenate([quiet, busy]))
    measured = loudness.measure(audio)
    curve = energy.energy_curve(audio.mean(axis=1), measured.short_term_lufs)

    assert energy.HOP_SEC == 0.5
    assert curve.shape[0] == math.ceil(20.0 / 0.5) == measured.short_term_lufs.shape[0]
    assert np.all(curve >= 0.0)
    assert np.all(curve <= 1.0)
    # The busy half is clearly more energetic than the quiet half.
    assert curve[28:36].mean() > curve[4:12].mean() + 0.3


def test_energy_of_digital_silence_is_zero() -> None:
    audio = np.zeros((SR * 4, 2), dtype=np.float32)
    measured = loudness.measure(audio)
    curve = energy.energy_curve(audio.mean(axis=1), measured.short_term_lufs)
    assert np.all(curve == 0.0)


def test_missing_features_hand_their_weight_to_the_others() -> None:
    weights = energy.load_weights()
    assert weights == {
        "loudness_st": 0.40,
        "onset_density": 0.25,
        "spectral_centroid": 0.15,
        "active_stem_weight": 0.20,
    }
    series = np.linspace(-30.0, -10.0, 20)
    only_loudness = energy.combine({"loudness_st": series}, weights)
    with_zero_others = energy.combine(
        {
            "loudness_st": series,
            "onset_density": np.zeros(20),
            "spectral_centroid": np.zeros(20),
        },
        weights,
    )
    # With only one feature its weight is renormalised to 1, so it moves the curve more.
    assert (
        only_loudness.max() - only_loudness.min() > with_zero_others.max() - with_zero_others.min()
    )


def test_combine_rejects_a_configuration_with_no_usable_weight() -> None:
    with pytest.raises(ValueError, match="positive weight"):
        energy.combine({"loudness_st": np.zeros(3)}, {"loudness_st": 0.0})


@needs_ffmpeg
def test_capability_returns_a_schema_valid_blob(tmp_path: Path) -> None:
    audio = stereo(np.concatenate([sine(6.0, SR, amplitude=db(-30.0)), drum_loop(6.0, -8.0)]))
    context = FakeContext(tmp_path, wav_bytes(audio, SR))
    outputs = asyncio.run(
        loudness_energy.run(make_job("loudness_energy"), cast(JobContext, context))
    )
    assert outputs.blobs is not None
    result = json.loads(context.uploads[outputs.blobs["result"]])
    assert result["schemaVersion"] == 1
    assert result["hopSec"] == 0.5
    assert len(result["energy"]) == len(result["shortTermLufs"]) == 24
    assert all(0.0 <= v <= 1.0 for v in result["energy"])
    assert result["lra"] >= 0.0
    assert -70.0 <= result["lufsIntegrated"] <= 0.0
    assert "absoluteEnergy" not in result
    assert "sections" not in result


@needs_ffmpeg
def test_agrees_with_ffmpeg_ebur128_on_programme_like_audio(tmp_path: Path) -> None:
    rng = np.random.default_rng(3)
    parts = []
    for level in (-26.0, -14.0, -20.0, -10.0, -32.0, -18.0):
        noise = rng.normal(0.0, 1.0, (SR * 8, 2)).astype(np.float32)
        tone = np.stack([sine(8.0, SR, 330.0)] * 2, axis=1)
        parts.append((0.5 * noise + tone) * db(level) * 0.4)
    audio = np.concatenate(parts)
    path = tmp_path / "programme.wav"
    path.write_bytes(wav_bytes(np.clip(audio, -1, 1), SR))

    reference = subprocess.run(
        ["ffmpeg", "-nostats", "-i", str(path), "-af", "ebur128=peak=true", "-f", "null", "-"],
        capture_output=True,
        text=True,
        check=True,
    ).stderr
    summary = reference[reference.rindex("Summary:") :]
    ref_i = float(re.search(r"I:\s+(-?[\d.]+) LUFS", summary).group(1))  # type: ignore[union-attr]
    ref_lra = float(re.search(r"LRA:\s+([\d.]+) LU", summary).group(1))  # type: ignore[union-attr]
    ref_peak = float(re.search(r"Peak:\s+(-?[\d.]+) dBFS", summary).group(1))  # type: ignore[union-attr]

    pcm = np.clip(audio, -1, 1)
    # Quantise like the WAV the reference saw.
    pcm = np.round(pcm * 32767) / 32767
    ours = loudness.measure(pcm.astype(np.float32))
    assert ours.integrated_lufs == pytest.approx(ref_i, abs=0.1)
    assert ours.lra == pytest.approx(ref_lra, abs=0.5)
    assert ours.true_peak_db == pytest.approx(ref_peak, abs=0.3)
