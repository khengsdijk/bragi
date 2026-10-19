"""The separation numerics, tested with stub backends: no torch, no weights."""

from __future__ import annotations

import numpy as np
import pytest

from bragi_analysis.separation import pipeline as pl
from bragi_analysis.separation.audio import decode_flac, encode_flac

RATE = 48_000


def music_like(seconds: float, seed: int = 0) -> np.ndarray:
    """A deterministic stereo signal at a believable level (not silence, not clipped)."""
    n = int(seconds * RATE)
    t = np.arange(n) / RATE
    rng = np.random.default_rng(seed)
    left = 0.3 * np.sin(2 * np.pi * 220 * t) + 0.1 * rng.standard_normal(n)
    right = 0.25 * np.sin(2 * np.pi * 330 * t) + 0.1 * rng.standard_normal(n)
    return np.clip(np.stack([left, right]), -0.95, 0.95)


class SplitBackend:
    """Splits the input into fixed fractions per stem, optionally at a different model rate."""

    def __init__(self, fractions: list[float], sample_rate: int = RATE, max_segment: float = 7.8):
        self._fractions = fractions
        self.sample_rate = sample_rate
        self.max_segment_sec = max_segment
        self.stem_names = [f"s{i}" for i in range(len(fractions))]
        self.calls: list[int] = []

    def separate(self, chunk: np.ndarray) -> np.ndarray:
        self.calls.append(chunk.shape[-1])
        return np.stack([chunk * f for f in self._fractions]).astype(np.float32)


def run_pipeline(mix: np.ndarray, backend: SplitBackend, segment_sec: float = 10.0) -> np.ndarray:
    x = pl.resample(mix, RATE, backend.sample_rate).astype(np.float32)
    segment = int(min(segment_sec, backend.max_segment_sec) * backend.sample_rate)
    chunks = pl.plan_chunks(x.shape[-1], segment, backend.sample_rate)
    stitcher = pl.Stitcher(len(backend.stem_names), 2, x.shape[-1], chunks)
    for i, c in enumerate(chunks):
        stitcher.add(i, backend.separate(x[:, c.start : c.end]))
    return stitcher.finish()


@pytest.mark.parametrize("total", [1, 100, 7_800, 7_801, 20_000, 123_457])
def test_chunks_cover_the_signal(total: int) -> None:
    chunks = pl.plan_chunks(total, segment=7_800, overlap=1_000)
    assert chunks[0].start == 0 and chunks[-1].end == total
    for before, after in zip(chunks, chunks[1:], strict=False):
        assert after.start <= before.end  # no gap
        assert after.start > before.start  # always advances
    assert all(c.length <= 7_800 for c in chunks)
    if total > 7_800:  # every chunk is a full segment, including the anchored last one
        assert all(c.length == 7_800 for c in chunks)


def test_chunk_plan_rejects_overlap_not_shorter_than_segment() -> None:
    with pytest.raises(ValueError, match="longer than overlap"):
        pl.plan_chunks(1000, segment=100, overlap=100)


@pytest.mark.parametrize("seconds", [3.0, 10.0, 25.3, 61.7])
def test_identity_backend_reproduces_the_input_through_the_crossfade(seconds: float) -> None:
    mix = music_like(seconds)
    stems = run_pipeline(mix, SplitBackend([1.0]))
    assert stems.shape == (1, 2, mix.shape[-1])
    assert np.max(np.abs(stems[0] - mix)) < 1e-6  # float32 accumulation only


def test_crossfade_weights_sum_to_one_with_a_wide_last_overlap() -> None:
    # 25.3 s forces the anchored last chunk to overlap its predecessor by more than 1 s.
    mix = music_like(25.3)
    backend = SplitBackend([1.0])
    stems = run_pipeline(mix, backend)
    assert len(backend.calls) == 4  # 7.8 s segments, 1 s overlap
    assert np.max(np.abs(stems[0] - mix)) < 1e-6


def test_stems_sum_back_to_the_mix_at_a_foreign_model_rate() -> None:
    t = np.arange(20 * RATE) / RATE
    band_limited = np.stack(
        [0.3 * np.sin(2 * np.pi * f * t + p) for f, p in ((110, 0.0), (1_700, 1.0), (9_000, 2.0))]
    ).sum(axis=0)
    mix = np.stack([band_limited, 0.8 * band_limited])
    backend = SplitBackend([0.5, 0.3, 0.2], sample_rate=44_100)
    stems = run_pipeline(mix, backend)
    back = np.sum(
        [
            pl.fit_length(pl.resample(s.astype(np.float64), 44_100, RATE), mix.shape[-1])
            for s in stems
        ],
        axis=0,
    )
    # 48 -> 44.1 -> 48 kHz is not bit-exact; for in-band content it is far below the -60 dB gate.
    rms, _ = pl.null_db(mix, [back], np.zeros_like(mix))
    assert rms < -80.0


def test_content_above_the_model_nyquist_is_not_lost_it_lands_in_the_residual() -> None:
    # White noise reaches 24 kHz; a 44.1 kHz model cannot carry 22.05-24 kHz, so the round trip
    # loses it (about -30 dB here). The residual is computed against the stored stems, so the
    # acceptance null still holds.
    mix = music_like(10.0)
    stems = run_pipeline(mix, SplitBackend([1.0], sample_rate=44_100))
    stem = pl.fit_length(pl.resample(stems[0].astype(np.float64), 44_100, RATE), mix.shape[-1])
    stored, _ = decode_flac(encode_flac(pl.clip_full_scale(stem), RATE))
    accumulator = pl.ResidualAccumulator(mix)
    accumulator.add(stored)
    residual = accumulator.residual()
    assert pl.rms_db(residual) > -45.0  # the lost band is really there
    assert pl.null_db(mix, [stored], residual)[0] <= -120.0


def test_resample_round_trip_length_and_noop() -> None:
    mix = music_like(2.0)
    assert pl.resample(mix, RATE, RATE) is mix
    down = pl.resample(mix, RATE, 44_100)
    assert abs(down.shape[-1] - round(mix.shape[-1] * 44_100 / RATE)) <= 1
    assert pl.fit_length(pl.resample(down, 44_100, RATE), mix.shape[-1]).shape == mix.shape


def test_rms_and_peak_in_dbfs() -> None:
    assert pl.rms_db(np.zeros((2, 10))) == -np.inf
    assert pl.rms_db(np.full((2, 10), 0.5)) == pytest.approx(-6.0206, abs=1e-3)
    assert pl.peak_db(np.array([[0.1, -0.5]])) == pytest.approx(-6.0206, abs=1e-3)


def test_clip_full_scale_keeps_stems_inside_flac_range() -> None:
    clipped = pl.clip_full_scale(np.array([-3.0, -1.0, 0.0, 0.5, 2.0]))
    assert clipped.min() == -1.0 and clipped.max() == pl.FULL_SCALE_24 < 1.0


def test_flac_round_trip_is_24_bit_exact_on_the_grid() -> None:
    grid = np.round(music_like(1.0) * 2**23) / 2**23
    decoded, rate = decode_flac(encode_flac(grid, RATE))
    assert rate == RATE and decoded.shape == grid.shape
    assert np.max(np.abs(decoded - grid)) <= 2.0**-23  # at most one LSB


def test_residual_nulls_the_mix_after_flac_quantisation() -> None:
    """The acceptance measure (12, WP-1.3): mix - sum(stems) - residual <= -60 dBFS."""
    mix_float = music_like(30.0)
    mix, _ = decode_flac(encode_flac(mix_float, RATE))  # the working asset is itself 24-bit
    stems = run_pipeline(mix, SplitBackend([0.45, 0.3, 0.15, 0.07]))
    accumulator = pl.ResidualAccumulator(mix)
    stored = []
    for stem in stems:
        data = encode_flac(pl.clip_full_scale(stem.astype(np.float64)), RATE)
        decoded, _ = decode_flac(data)
        accumulator.add(decoded)
        stored.append(decoded)
    residual_file, _ = decode_flac(encode_flac(pl.clip_full_scale(accumulator.residual()), RATE))
    rms, peak = pl.null_db(mix, stored, residual_file)
    assert rms <= -60.0 and peak <= -60.0
    assert rms <= -120.0  # in practice it is the 24-bit grid: about -138 dBFS


def test_dropping_a_silent_stem_leaves_its_content_in_the_residual() -> None:
    mix, _ = decode_flac(encode_flac(music_like(10.0), RATE))
    fractions = [0.8, 0.2 - 1e-4, 1e-4]  # sums to 1; the third stem is ~ -80 dB: below the floor
    stems = run_pipeline(mix, SplitBackend(fractions))
    levels = [pl.rms_db(s.astype(np.float64)) for s in stems]
    kept = [i for i, level in enumerate(levels) if level >= pl.SILENCE_FLOOR_DB]
    assert kept == [0, 1]

    accumulator = pl.ResidualAccumulator(mix)
    stored = []
    for i in kept:
        decoded, _ = decode_flac(encode_flac(stems[i].astype(np.float64), RATE))
        accumulator.add(decoded)
        stored.append(decoded)
    residual = accumulator.residual()
    assert -100.0 < pl.rms_db(residual) < -80.0  # it holds the dropped stem, about -91 dBFS
    rms, _ = pl.null_db(mix, stored, residual)
    assert rms <= -120.0


def test_a_stem_that_overshoots_full_scale_is_clipped_before_the_residual() -> None:
    mix, _ = decode_flac(encode_flac(music_like(5.0), RATE))
    loud = pl.clip_full_scale(mix * 3.0)  # a model overshoot
    assert loud.max() <= pl.FULL_SCALE_24
    decoded, _ = decode_flac(encode_flac(loud, RATE))
    accumulator = pl.ResidualAccumulator(mix)
    accumulator.add(decoded)
    residual, _ = decode_flac(encode_flac(pl.clip_full_scale(accumulator.residual()), RATE))
    rms, _ = pl.null_db(mix, [decoded], residual)
    assert rms <= -120.0  # residual = mix - stem stays inside +-1 here, so the null still holds


def test_stitcher_rejects_wrong_chunk_length_and_missing_chunks() -> None:
    chunks = pl.plan_chunks(100, 60, 10)
    stitcher = pl.Stitcher(1, 2, 100, chunks)
    with pytest.raises(ValueError, match="expected"):
        stitcher.add(0, np.zeros((1, 2, 5), dtype=np.float32))
    stitcher.add(0, np.zeros((1, 2, chunks[0].length), dtype=np.float32))
    with pytest.raises(ValueError, match="chunks were added"):
        stitcher.finish()
