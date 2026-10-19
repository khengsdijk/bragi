"""``harmony``: chroma, key, chords, roman numerals and the fingerprint (WP-1.5)."""

from __future__ import annotations

import mir_eval
import numpy as np
import pytest
from harmony_support import SAMPLE_RATE, detected, reference, render

from bragi_analysis.harmony import chords, chroma, pipeline
from bragi_analysis.harmony import key as keys

#: I-IV-V-I in C major.
C_MAJOR = [(0, "maj"), (5, "maj"), (7, "maj"), (0, "maj")]
#: i-iv-V-i in A minor (with the dominant's raised leading tone), unambiguous minor.
A_MINOR = [(9, "min"), (2, "min"), (4, "maj"), (9, "min")]
#: i-VI-III-VII in A minor: an unambiguous minor-key loop for the fingerprint test.
A_MINOR_LOOP = [(9, "min"), (5, "maj"), (0, "maj"), (7, "maj")]


def frames_of(audio: np.ndarray) -> chroma.ChromaFrames:
    return chroma.chroma_frames(audio, SAMPLE_RATE)


# --- chroma ---------------------------------------------------------------------------------


def test_chroma_puts_a_major_triad_on_its_three_pitch_classes() -> None:
    profile = frames_of(render([(0, "maj")], reps=1)).vectors.sum(axis=0)
    top = set(np.argsort(profile)[-3:].tolist())
    assert top == {0, 4, 7}  # C, E, G


def test_chroma_of_silence_is_zero() -> None:
    frames = frames_of(np.zeros(SAMPLE_RATE * 3, dtype=np.float32))
    assert not frames.vectors.any()
    assert float(frames.energy.sum()) == 0.0


def test_beat_sync_averages_frames_into_beat_intervals() -> None:
    audio = render(C_MAJOR, reps=2)
    frames = frames_of(audio)
    duration = audio.shape[0] / SAMPLE_RATE
    beats = np.arange(0.0, duration, 0.5)
    synced = chroma.beat_sync(frames, beats, duration)
    assert synced.vectors.shape[0] == np.unique(np.concatenate([[0.0], beats, [duration]])).size - 1
    assert synced.vectors.shape[1] == 12
    assert synced.edges[-1] == pytest.approx(duration)


# --- key ------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("progression", "expected"), [(C_MAJOR, (0, "major")), (A_MINOR, (9, "minor"))]
)
def test_key_estimation_reads_the_right_key(
    progression: list[tuple[int, str]], expected: tuple[int, str]
) -> None:
    frames = frames_of(render(progression, reps=2))
    key = keys.estimate_key(frames.vectors, frames.energy)
    assert (key.tonic_pc, key.mode) == expected
    assert key.confidence > 0.4


def test_key_estimation_flags_silence_and_noise() -> None:
    silent = keys.estimate_key(*_vectors_of(np.zeros(SAMPLE_RATE * 3, dtype=np.float32)))
    assert silent.confidence == 0.0
    noise = np.random.default_rng(0).standard_normal(SAMPLE_RATE * 6).astype(np.float32) * 0.1
    noisy = keys.estimate_key(*_vectors_of(noise))
    assert noisy.confidence < 0.4


def _vectors_of(audio: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    frames = frames_of(audio)
    return frames.vectors, frames.energy


# --- chords ---------------------------------------------------------------------------------


def test_chord_decoding_recovers_the_triad_sequence() -> None:
    segments = chords.decode(frames_of(render(C_MAJOR, reps=2)))
    symbols = [s.symbol for s in segments]
    assert symbols[:4] == ["C", "F", "G", "C"]
    assert all(s.quality == "maj" for s in segments)


def test_chord_accuracy_on_synthetic_triads_is_high() -> None:
    progression = C_MAJOR
    segments = chords.decode(frames_of(render(progression, reps=2)))
    ref_intervals, ref_labels = reference(progression, reps=2)
    est_intervals, est_labels = detected(segments)
    score = mir_eval.chord.evaluate(ref_intervals, ref_labels, est_intervals, est_labels)["majmin"]
    assert score >= 0.9


def test_seventh_chords_are_decoded() -> None:
    progression = [(0, "maj7"), (9, "min7"), (2, "min7"), (7, "7")]
    segments = chords.decode(frames_of(render(progression, reps=2)))
    assert [s.quality for s in segments[:4]] == ["maj7", "min7", "min7", "7"]


def test_silence_decodes_to_no_chords() -> None:
    assert chords.decode(frames_of(np.zeros(SAMPLE_RATE * 4, dtype=np.float32))) == []


def test_recognizer_selection_and_template_bank() -> None:
    assert chords.select("auto").name == "chroma-template"
    assert chords.select("template").name == "chroma-template"
    with pytest.raises(ValueError, match="recognizer"):
        chords.select("neural")
    for quality in ("maj", "min", "maj7", "min7", "dim", "aug"):
        assert quality in chords.INTERVALS


# --- roman numerals and the fingerprint -----------------------------------------------------


def test_roman_numerals_in_major_and_minor() -> None:
    c_major = keys.Key(0, "major", 1.0)
    a_minor = keys.Key(9, "minor", 1.0)
    assert keys.roman_numeral(0, "maj", c_major) == "I"
    assert keys.roman_numeral(9, "min", c_major) == "vi"
    assert keys.roman_numeral(7, "7", c_major) == "V7"
    assert keys.roman_numeral(11, "dim", c_major) == "vii\u00b0"
    assert keys.roman_numeral(11, "min7b5", c_major) == "vii\u00f87"
    assert keys.roman_numeral(10, "maj", c_major) == "bVII"
    assert keys.roman_numeral(9, "min", a_minor) == "i"
    assert keys.roman_numeral(2, "min", a_minor) == "iv"
    assert keys.roman_numeral(5, "maj", a_minor) == "VI"
    assert keys.roman_numeral(0, "maj", a_minor) == "III"
    assert keys.roman_numeral(7, "maj", a_minor) == "VII"


def test_fingerprint_collapses_repeats_and_marks_emptiness() -> None:
    assert keys.fingerprint(["i", "i", "VI", "III", "III", "VII"]) == "i-VI-III-VII"
    assert keys.fingerprint([]) == "N"


def test_transposed_fixture_has_the_same_fingerprint() -> None:
    """Acceptance 3: a transposed fixture gives the same ``progressionFingerprint``."""
    fingerprints = set()
    for shift in (0, 2, 5, 7, 10):
        audio = render(A_MINOR_LOOP, reps=2, transpose=shift)
        result = pipeline.build_result(frames_of(audio), audio.shape[0] / SAMPLE_RATE)
        assert result.sections is not None
        fingerprints.add(tuple(s.progressionFingerprint for s in result.sections))
    assert len(fingerprints) == 1
    assert fingerprints.pop() != ("N",)


# --- sections and the pipeline --------------------------------------------------------------


def test_structure_sections_align_the_progressions() -> None:
    audio = render(C_MAJOR, reps=4)
    frames = frames_of(audio)
    duration = audio.shape[0] / SAMPLE_RATE
    spans = [
        pipeline.SectionSpan(0, 0.0, duration / 2.0),
        pipeline.SectionSpan(1, duration / 2.0, duration),
    ]
    result = pipeline.build_result(frames, duration, sections=spans)
    assert result.sections is not None
    assert [section.index for section in result.sections] == [0, 1]
    assert all(section.progressionFingerprint != "N" for section in result.sections)
    # Without structure, one whole-song progression at index 0.
    fallback = pipeline.build_result(frames, duration)
    assert fallback.sections is not None
    assert [section.index for section in fallback.sections] == [0]


def test_beat_synchronous_decoding_lands_on_beat_boundaries() -> None:
    audio = render(C_MAJOR, reps=2)
    frames = frames_of(audio)
    duration = audio.shape[0] / SAMPLE_RATE
    beats = np.arange(0.5, duration, 0.5)
    result = pipeline.build_result(frames, duration, beats=beats)
    edges = np.unique(np.concatenate([[0.0], beats, [duration]]))
    assert result.chords
    for chord in result.chords:
        assert np.min(np.abs(edges - chord.endSec)) < 1e-3


def test_no_beats_falls_back_to_the_frame_grid() -> None:
    audio = render(C_MAJOR, reps=2)
    duration = audio.shape[0] / SAMPLE_RATE
    with_beats = pipeline.build_result(frames_of(audio), duration, beats=np.zeros(0))
    without = pipeline.build_result(frames_of(audio), duration)
    assert with_beats.model_dump() == without.model_dump()


def test_no_key_change_on_a_static_song() -> None:
    static = render(C_MAJOR, reps=4)
    frames = frames_of(static)
    key = keys.estimate_key(frames.vectors, frames.energy)
    assert keys.detect_key_changes(frames, key) == []


def _profile_frames(tonic_pc: int, seconds: float) -> chroma.ChromaFrames:
    """Frames shaped like the key profile, so local keys are unambiguous."""
    hop = chroma.HOP / chroma.CHROMA_RATE
    profile = np.roll(keys.KRUMHANSL_MAJOR, tonic_pc)
    profile = profile / np.linalg.norm(profile)
    count = round(seconds / hop)
    vectors = np.tile(profile, (count, 1)).astype(np.float32)
    edges = np.arange(count + 1, dtype=np.float64) * hop
    return chroma.ChromaFrames(edges=edges, vectors=vectors, energy=np.ones(count))


def test_key_change_is_detected_on_a_sustained_modulation() -> None:
    c_part = _profile_frames(0, 10.0)
    d_part = _profile_frames(2, 10.0)
    vectors = np.concatenate([c_part.vectors, d_part.vectors])
    frames = chroma.ChromaFrames(
        edges=np.arange(vectors.shape[0] + 1, dtype=np.float64) * (chroma.HOP / chroma.CHROMA_RATE),
        vectors=vectors,
        energy=np.ones(vectors.shape[0]),
    )
    changes = keys.detect_key_changes(frames, keys.Key(0, "major", 1.0), window_sec=4.0, min_run=2)
    assert changes
    assert changes[0].tonic_pc == 2 and changes[0].mode == "major"
    assert changes[0].at_sec == 12.0


def test_result_round_trips_through_the_schema_model() -> None:
    audio = render(A_MINOR, reps=2)
    result = pipeline.build_result(frames_of(audio), audio.shape[0] / SAMPLE_RATE)
    again = type(result).model_validate_json(result.model_dump_json(exclude_none=True))
    assert again == result


# --- graceful degradation -------------------------------------------------------------------


def test_silence_short_and_noise_are_low_confidence_and_never_fail() -> None:
    cases = {
        "silence": np.zeros(SAMPLE_RATE * 5, dtype=np.float32),
        "short": render([(0, "maj")], reps=1, seconds=0.3),
        "noise": np.random.default_rng(1).standard_normal(SAMPLE_RATE * 6).astype(np.float32) * 0.1,
    }
    for name, audio in cases.items():
        result = pipeline.build_result(frames_of(audio), audio.shape[0] / SAMPLE_RATE)
        assert result.lowConfidence is True, name
        again = type(result).model_validate_json(result.model_dump_json(exclude_none=True))
        assert again == result, name
    silence = pipeline.build_result(frames_of(cases["silence"]), 5.0)
    assert silence.chords == []
    assert silence.sections is None
