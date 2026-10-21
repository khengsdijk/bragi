"""The whole gate pipeline (09 §6): order, verdicts, rejection paths, determinism."""

from __future__ import annotations

import numpy as np
import pytest
from gates_support import SAMPLE_RATE, audio, clipped, metric, request, scale, slice_audio, song

from bragi_generate.postprocess import postprocess
from bragi_generate.postprocess.config import GateConfig
from bragi_generate.postprocess.types import Audio, Direction, GateResult

CFG = GateConfig()
SONG = song(120.0, 24.0)
CONTEXT = slice_audio(SONG, 0.0, 8.0)
CANDIDATE = slice_audio(SONG, 8.0, 16.0)


def _run(
    candidate: Audio, context: Audio = CONTEXT, direction: Direction = "forward"
) -> GateResult:
    return postprocess(candidate, context, request(120.0, direction=direction), CFG)


def test_matching_continuation_passes_every_step() -> None:
    result = _run(CANDIDATE)
    assert result.passed
    assert result.quality_warning is False
    assert len(result.steps) == 7
    assert all(verdict.passed for verdict in result.steps)
    assert [verdict.step for verdict in result.steps] == [
        "sanity",
        "tempo",
        "key",
        "beat_align",
        "splice",
        "match",
        "final_seam",
    ]
    assert result.tempo_error < 0.04
    assert result.key_match is not None
    assert result.key_match.relation == "same"
    assert result.match_eq is not None
    assert len(result.match_eq.bands) == 31
    assert result.seam_score < 1.0


def test_processed_audio_is_trimmed_at_the_splice() -> None:
    result = _run(CANDIDATE)
    overlap = round(request(120.0).overlap_sec * SAMPLE_RATE)
    assert result.splice_offset_samples < 0
    assert 0 < result.splice_offset_samples + overlap < overlap
    assert result.processed.frames < CANDIDATE.frames
    assert result.splice_offset_samples > -overlap


def test_loudness_jump_fails_the_splice_gate() -> None:
    result = _run(CANDIDATE, scale(CONTEXT, 0.25))
    assert not result.passed
    assert result.quality_warning is True
    assert result.verdict("splice").passed is False
    assert metric(result.verdict("splice"), "loudness_jump_lu") > 3.0
    # 09 §6: a failed candidate still comes back, flagged, with audio to audition.
    assert result.processed.frames > 0


def test_eight_percent_tempo_is_rejected_without_touching_later_steps() -> None:
    off = slice_audio(song(129.6, 16.0), 8.0, 16.0)
    result = _run(off)
    assert not result.passed
    assert result.verdict("tempo").passed is False
    assert metric(result.verdict("tempo"), "tempo_error") > CFG.tempo_max_error
    assert result.verdict("key").skipped
    assert result.verdict("splice").skipped
    assert result.tempo_error > CFG.tempo_max_error


def test_tritone_off_is_rejected_at_the_key_gate() -> None:
    tritone = slice_audio(song(120.0, 16.0, root_pc=6), 8.0, 16.0)
    result = _run(tritone)
    assert not result.passed
    assert result.verdict("key").passed is False
    assert result.key_match is not None
    assert result.key_match.relation == "off"
    assert result.verdict("beat_align").skipped


def test_one_semitone_is_fixed_before_splicing() -> None:
    shifted = slice_audio(song(120.0, 16.0, transpose=1), 8.0, 16.0)
    result = _run(shifted)
    assert result.verdict("key").passed
    assert result.key_match is not None
    assert result.key_match.shift_semitones == -1
    assert result.passed


@pytest.mark.parametrize(
    ("candidate", "reason"),
    [
        (scale(CANDIDATE, 0.0), "silent"),
        (clipped(CANDIDATE), "clipped"),
    ],
)
def test_sanity_rejections(candidate: Audio, reason: str) -> None:
    result = _run(candidate)
    assert not result.passed
    assert result.verdict("sanity").reason == reason
    assert result.verdict("tempo").skipped
    assert result.seam_score == float("inf")


def test_nan_is_rejected() -> None:
    samples = CANDIDATE.samples.copy()
    samples[10, 0] = np.nan
    result = _run(audio(samples))
    assert not result.passed
    assert result.verdict("sanity").reason == "non-finite samples"


def test_backward_direction_mirrors_the_pipeline() -> None:
    context = slice_audio(SONG, 8.0, 16.0)
    candidate = slice_audio(SONG, 0.0, 8.0)
    result = postprocess(candidate, context, request(120.0, direction="backward"), CFG)
    assert result.direction == "backward"
    assert result.passed
    overlap = round(request(120.0).overlap_sec * SAMPLE_RATE)
    assert result.splice_offset_samples < 0
    assert result.processed.frames < candidate.frames
    assert result.splice_offset_samples > -overlap


def test_pipeline_is_deterministic() -> None:
    first = _run(CANDIDATE)
    second = _run(CANDIDATE)
    assert np.array_equal(first.processed.samples, second.processed.samples)
    assert first.seam_score == second.seam_score
    assert first.splice_offset_samples == second.splice_offset_samples
    assert first.steps == second.steps
    assert first.match_eq == second.match_eq


def test_mismatched_sample_rates_are_refused() -> None:
    other = audio(CANDIDATE.samples[::2], 24_000)
    with pytest.raises(ValueError, match="24000 Hz"):
        postprocess(other, CONTEXT, request(120.0), CFG)


def test_empty_context_is_refused() -> None:
    with pytest.raises(ValueError, match="context is empty"):
        postprocess(CANDIDATE, audio(np.zeros((0, 2), np.float32)), request(120.0), CFG)
