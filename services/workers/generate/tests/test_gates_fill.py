"""The two-sided gates of 09 §6 on synthetic signals (WP-2.8 task A)."""

from __future__ import annotations

import numpy as np
import pytest
from gates_support import SAMPLE_RATE, audio, metric, slice_audio, song

from bragi_generate.postprocess import FillGateRequest, GateConfig, KeySpec, postprocess_fill
from bragi_generate.postprocess.types import Audio

CFG = GateConfig()
BPM = 120.0
SONG = song(BPM, 32.0)
# 4 s = 2 bars at 120 BPM in 4/4; the same length on each side of the gap.
BAR = 2.0
GAP_BARS = 2
OVERLAP_BARS = 2
BEFORE = slice_audio(SONG, 0.0, 16.0)
AFTER = slice_audio(SONG, 20.0, 32.0)


def inpaint_request(*, overlap_bars: int = OVERLAP_BARS) -> FillGateRequest:
    """A C-major 4/4 inpaint with a two-bar gap."""
    return FillGateRequest(
        bpm=BPM,
        time_signature=(4, 4),
        key=KeySpec.parse("C", "major"),
        gap_bars=GAP_BARS,
        lead_bars=0.0,
        overlap_bars=overlap_bars,
    )


def transition_request(*, length_bars: int = 2) -> FillGateRequest:
    """A C-major 4/4 transition of ``length_bars`` centred on the join."""
    return FillGateRequest(
        bpm=BPM,
        time_signature=(4, 4),
        key=KeySpec.parse("C", "major"),
        gap_bars=0,
        lead_bars=length_bars / 2.0,
        overlap_bars=OVERLAP_BARS,
    )


def perfect_inpaint() -> Audio:
    """The span the song actually plays, including both overlaps."""
    start = BEFORE.duration_sec - OVERLAP_BARS * BAR
    return slice_audio(SONG, start, BEFORE.duration_sec + GAP_BARS * BAR + OVERLAP_BARS * BAR)


def test_a_perfect_fill_passes_both_seams_and_reports_both_offsets() -> None:
    result = postprocess_fill(perfect_inpaint(), BEFORE, AFTER, inpaint_request(), CFG)

    assert result.passed, [(step.step, step.reason) for step in result.steps]
    assert result.quality_warning is False
    assert [step.step for step in result.steps] == [
        "sanity",
        "tempo",
        "key",
        "beat_align",
        "splice",
        "match",
        "final_seam",
    ]
    assert result.seam_score < 0.5
    assert result.end_seam_score < 0.5
    overlap = OVERLAP_BARS * BAR * SAMPLE_RATE
    assert -overlap < result.start_offset_samples < 0
    assert 0 < result.end_offset_samples <= overlap
    assert result.processed.frames > 0
    assert result.match_eq is not None and len(result.match_eq.bands) == 31


def test_the_start_splice_metrics_carry_the_end_seam() -> None:
    result = postprocess_fill(perfect_inpaint(), BEFORE, AFTER, inpaint_request(), CFG)
    verdict = result.verdict("splice")

    assert verdict.passed
    assert "seam_score" in verdict.metrics
    assert "end_seam_score" in verdict.metrics
    assert "end_position" in verdict.metrics
    assert float(verdict.metrics["end_candidates"]) >= 1
    final = result.verdict("final_seam")
    assert final.metrics["end_seam_score"] == pytest.approx(
        round(result.end_seam_score, 4), abs=1e-4
    )


def test_a_bad_end_seam_fails_the_splice_gate_while_the_start_stays_good() -> None:
    candidate = perfect_inpaint()
    samples = candidate.samples.copy()
    tail = round(OVERLAP_BARS * BAR * SAMPLE_RATE)
    samples[-tail:] = 0.0  # the tail re-creation is silent: the handover to after jumps

    result = postprocess_fill(audio(samples), BEFORE, AFTER, inpaint_request(), CFG)

    assert not result.passed
    assert result.quality_warning is True
    splice = result.verdict("splice")
    assert not splice.passed
    assert splice.reason is not None and "end seam" in splice.reason
    assert metric(splice, "end_seam_score") > CFG.seam_max_score
    # The start side was fine; only the end seam is the culprit.
    assert metric(splice, "seam_score") < CFG.seam_max_score
    assert result.end_seam_score > CFG.seam_max_score
    assert result.processed.frames > 0


def test_a_transition_is_centred_on_the_join() -> None:
    # The bridge replaces one bar on each side of the boundary at 16 s; with a
    # two-bar overlap the candidate runs from 10 s to 22 s.
    candidate = slice_audio(SONG, 10.0, 22.0)
    result = postprocess_fill(candidate, BEFORE, AFTER, transition_request(), CFG)

    assert result.passed, [(step.step, step.reason) for step in result.steps]
    lead = BAR * SAMPLE_RATE
    overlap = OVERLAP_BARS * BAR * SAMPLE_RATE
    # Starts before the boundary (inside the before overlap) and ends inside after.
    assert -lead - overlap < result.start_offset_samples < -lead
    assert lead < result.end_offset_samples < lead + overlap
    # The processed clip is the bridge plus the crossfade regions, not the bridge
    # alone; the app crossfades those regions away.
    assert 2 * BAR < result.processed.duration_sec < candidate.duration_sec


def test_the_loudness_match_uses_after_for_the_tail() -> None:
    candidate = perfect_inpaint()
    samples = candidate.samples.copy()
    tail = round(OVERLAP_BARS * BAR * SAMPLE_RATE)
    samples[-tail:] *= 0.25  # 12 dB quieter than the right context

    result = postprocess_fill(audio(samples), BEFORE, AFTER, inpaint_request(), CFG)

    match = result.verdict("match")
    assert match.skipped is False
    # The head is the song itself (within a couple of dB); the tail is the quiet one.
    assert abs(metric(match, "head_gain_db")) < 4.0
    assert metric(match, "tail_gain_db") > 8.0
    assert metric(match, "tail_gain_db") > metric(match, "head_gain_db") + 6.0


def test_a_short_overlap_still_finds_both_splices() -> None:
    # One bar leaves 0.5 s of search room after the window and the fade; at half
    # time the tracked grid can hold no beat there, so the requested grid fills in.
    request = inpaint_request(overlap_bars=1)
    candidate = slice_audio(SONG, 14.0, 22.0)
    result = postprocess_fill(candidate, BEFORE, AFTER, request, CFG)

    assert result.passed, [(step.step, step.reason) for step in result.steps]
    assert result.start_offset_samples < 0
    assert result.end_offset_samples > 0


def test_mismatched_rates_and_short_contexts_are_rejected() -> None:
    candidate = perfect_inpaint()
    with pytest.raises(ValueError, match="sample rate"):
        postprocess_fill(
            candidate,
            BEFORE,
            Audio(AFTER.samples, 44_100),
            inpaint_request(),
            CFG,
        )
    short = Audio(AFTER.samples[:SAMPLE_RATE], AFTER.sample_rate)
    with pytest.raises(ValueError, match="longer than the lead"):
        postprocess_fill(candidate, BEFORE, short, transition_request(), CFG)


def test_silence_in_the_whole_candidate_is_rejected_at_sanity() -> None:
    silence = Audio(np.zeros((SAMPLE_RATE * 8, 2), dtype=np.float32), SAMPLE_RATE)
    result = postprocess_fill(silence, BEFORE, AFTER, inpaint_request(), CFG)

    assert not result.passed
    assert result.verdict("sanity").reason == "silent"
    assert result.seam_score == float("inf")
    assert result.end_seam_score == float("inf")
