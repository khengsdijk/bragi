"""``structure``: snapping, grouping, labels, the pipeline, the capability, the metrics (WP-1.4).

Every signal is generated (``evaluation/synthetic_songs.py``); nothing is checked in. The
synthetic numbers prove the machinery, never real-music accuracy (04 §8).
"""

from __future__ import annotations

import asyncio
import datetime
import hashlib
import itertools
import json
from pathlib import Path
from typing import cast

import numpy as np
import pytest
from analysis_support import FakeContext, make_job, needs_ffmpeg, wav_bytes

from bragi_analysis.capabilities import structure as structure_capability
from bragi_analysis.evaluation import harness, metrics, structure_eval, synthetic_songs
from bragi_analysis.structure import grouping, labels, novelty, pipeline, snap
from bragi_analysis.trackers.dsp import DspTracker
from bragi_common.context import JobContext
from bragi_common.generated.models import (
    FreeformParams,
    JobInputs,
    RhythmResult,
    SectionKind,
    StructureResult,
)

SECTION = metrics.LabelledSection


@pytest.fixture(scope="module")
def songs() -> list[synthetic_songs.SyntheticSong]:
    return synthetic_songs.suite()


# --- snapping (04 5.2) ---------------------------------------------------------------------


def grid(bpm: float = 120.0, bars: int = 24) -> tuple[np.ndarray, np.ndarray]:
    beats = np.arange(bars * 4) * 60.0 / bpm
    return beats, beats[::4]


def test_a_boundary_within_a_beat_of_a_four_bar_line_goes_to_it() -> None:
    beats, downbeats = grid()  # 2 s per bar: 4-bar lines at 0, 8, 16, ...
    assert snap.snap_to_grid(16.3, beats, downbeats) == 16.0
    assert snap.snap_to_grid(15.6, beats, downbeats) == 16.0


def test_otherwise_a_two_bar_line_then_the_nearest_downbeat() -> None:
    beats, downbeats = grid()
    assert snap.snap_to_grid(13.6, beats, downbeats) == 14.0  # 2-bar line, 4-bar line is 2 s away
    assert snap.snap_to_grid(13.0, beats, downbeats) == 12.0  # a bar line only (nearest, tie low)


def test_without_downbeats_the_boundary_goes_to_the_nearest_beat() -> None:
    beats, _ = grid()
    assert snap.snap_to_grid(5.2, beats, np.zeros(0)) == 5.0
    assert snap.snap_to_grid(5.2, np.zeros(0), np.zeros(0)) == 5.2


def test_boundaries_that_collapse_or_crowd_are_dropped() -> None:
    beats, downbeats = grid()
    assert snap.snap_boundaries([16.1, 15.9, 8.0], beats, downbeats, min_gap_sec=4.0) == [8.0, 16.0]
    assert snap.snap_boundaries([16.0, 17.0], beats, downbeats, min_gap_sec=4.0) == [16.0]


# --- grouping ------------------------------------------------------------------------------


def test_identical_runs_group_and_different_or_mismatched_ones_do_not() -> None:
    rng = np.random.default_rng(0)
    a = rng.normal(size=(32, 8))
    b = rng.normal(size=(32, 8))
    assert grouping.section_similarity(a, a.copy()) == pytest.approx(1.0)
    assert grouping.section_similarity(a, b) < 0.4
    assert grouping.section_similarity(a, a[:16]) == 0.0  # half the length: not a repeat
    sim = grouping.similarity_matrix([a, b, a.copy(), b.copy(), a.copy()])
    assert grouping.group_sections(sim) == [0, 1, 0, 1, 0]


def test_group_letters() -> None:
    assert [grouping.group_letter(i) for i in (0, 1, 25, 26, 27)] == ["A", "B", "Z", "AA", "AB"]
    assert grouping.group_sections(np.eye(1)) == [0]


# --- labels and the taxonomy mapping -------------------------------------------------------


def test_the_taxonomy_maps_the_model_vocabulary_to_section_kinds() -> None:
    assert labels.to_section_kind("inst") == SectionKind.interlude
    assert labels.to_section_kind("break") == SectionKind.breakdown
    assert labels.to_section_kind("chorus") == SectionKind.chorus
    assert labels.to_section_kind("something new") == SectionKind.custom


def test_start_and_end_markers_merge_into_their_neighbours() -> None:
    merged = labels.merge_marker_sections(
        [(0, 1, "start"), (1, 20, "intro"), (20, 60, "verse"), (60, 62, "end")]
    )
    assert merged == [(0, 20, "intro"), (20, 62, "verse")]
    assert labels.merge_marker_sections([(0, 3, "start"), (3, 5, "end")]) == [(0, 5, "unknown")]


def stats(*items: tuple[int, float]) -> list[labels.SectionStats]:
    return [labels.SectionStats(g, e) for g, e in items]


def test_loudest_repeated_material_is_the_chorus_and_the_other_the_verse() -> None:
    result = labels.label_sections(
        stats((0, 0.1), (1, 0.4), (2, 0.9), (1, 0.4), (2, 0.9), (3, 0.5), (2, 0.9), (4, 0.1))
    )
    assert result == ["intro", "verse", "chorus", "verse", "chorus", "bridge", "chorus", "outro"]


def test_a_quiet_unique_section_mid_song_is_a_breakdown() -> None:
    result = labels.label_sections(
        stats((0, 0.5), (1, 0.9), (0, 0.5), (1, 0.9), (2, 0.05), (1, 0.9), (3, 0.3))
    )
    assert result[4] == "break"


def test_an_intro_that_returns_as_the_outro_is_a_bookend_not_a_verse() -> None:
    result = labels.label_sections(
        stats((0, 0.2), (1, 0.5), (2, 0.9), (1, 0.5), (2, 0.9), (0, 0.2))
    )
    assert result[0] == "intro"
    assert result[-1] == "outro"
    assert result[2] == "chorus"


def test_one_section_is_unknown() -> None:
    assert labels.label_sections(stats((0, 0.5))) == ["unknown"]
    assert labels.label_sections([]) == []


# --- the pipeline on songs with a known plan -----------------------------------------------


def test_novelty_peaks_sit_on_the_true_boundaries(
    songs: list[synthetic_songs.SyntheticSong],
) -> None:
    song = songs[0]
    analysis = pipeline.analyse(song.audio, song.sample_rate, song.beats, song.downbeats)
    picked = novelty.pick_boundaries(analysis.novelty)
    true_idx = {int(np.argmin(np.abs(song.beats - s.startSec))) for s in song.sections[1:]}
    found = set(picked.beat_index)
    assert all(any(abs(f - t) <= 4 for f in found) for t in true_idx)


def test_synthetic_songs_are_segmented_labelled_and_grouped(
    songs: list[synthetic_songs.SyntheticSong],
) -> None:
    for song in songs:
        analysis = pipeline.analyse(song.audio, song.sample_rate, song.beats, song.downbeats)
        reference = [SECTION(s.startSec, s.endSec, s.kind) for s in song.sections]
        estimate = structure_eval.from_result(analysis.result)
        hit, precision, _ = metrics.boundary_scores(reference, estimate)
        assert hit == 1.0, song.name
        assert precision == 1.0, song.name
        assert metrics.label_accuracy(reference, estimate) == pytest.approx(1.0), song.name
        assert metrics.chorus_grouping_correct(reference, estimate) is True, song.name
        assert not analysis.used_fallback_grid


def test_boundaries_land_on_downbeats_and_sections_tile_the_song(
    songs: list[synthetic_songs.SyntheticSong],
) -> None:
    song = songs[1]  # a lead-in: bar 1 starts at 0.8 s
    result = pipeline.analyse(song.audio, song.sample_rate, song.beats, song.downbeats).result
    sections = result.sections
    assert sections[0].startSec == 0.0
    assert sections[-1].endSec == pytest.approx(song.audio.size / song.sample_rate)
    for a, b in itertools.pairwise(sections):
        assert a.endSec == b.startSec
        assert any(abs(b.startSec - d) < 1e-6 for d in song.downbeats)
    assert all(0.0 <= s.confidence <= 1.0 for s in sections)
    assert not result.lowConfidence


def test_repeated_sections_share_a_group_and_a_different_one_does_not(
    songs: list[synthetic_songs.SyntheticSong],
) -> None:
    song = songs[0]
    sections = pipeline.analyse(
        song.audio, song.sample_rate, song.beats, song.downbeats
    ).result.sections
    by_kind: dict[str, set[str | None]] = {}
    for estimated, truth in zip(sections, song.sections, strict=True):
        by_kind.setdefault(truth.kind, set()).add(estimated.repeatGroup)
    assert all(len(groups) == 1 for groups in by_kind.values())
    assert len({next(iter(g)) for g in by_kind.values()}) == len(by_kind)


def test_the_whole_chain_with_the_dsp_tracker_finds_every_boundary() -> None:
    scores = structure_eval.score_synthetic(DspTracker())
    assert all(s.boundary_hit_rate == 1.0 for s in scores)
    # Not asserted: label accuracy / grouping through a *tracked* grid. One lead-in song gets
    # an extra section from the tracker's grid; that is a finding, reported in docs/wp/1.4.md.


def test_silence_noise_and_short_audio_degrade_to_one_flagged_section() -> None:
    rate = 22_050
    rng = np.random.default_rng(3)
    beats = np.arange(0, 60, 0.5)
    for audio in (
        np.zeros(60 * rate, dtype=np.float32),
        (0.1 * rng.normal(size=3 * rate)).astype(np.float32),
        np.zeros(0, dtype=np.float32),
    ):
        result = pipeline.analyse(audio, rate, beats, beats[::4]).result
        assert len(result.sections) == 1
        assert result.lowConfidence is True
        assert result.sections[0].startSec == 0.0


def test_a_missing_beat_grid_falls_back_and_says_so(
    songs: list[synthetic_songs.SyntheticSong],
) -> None:
    song = songs[2]
    analysis = pipeline.analyse(song.audio, song.sample_rate, np.zeros(0), np.zeros(0))
    assert analysis.used_fallback_grid
    assert analysis.result.lowConfidence is True
    assert len(analysis.result.sections) >= 2


def test_a_doubtful_beat_grid_flags_the_result(songs: list[synthetic_songs.SyntheticSong]) -> None:
    song = songs[0]
    result = pipeline.analyse(
        song.audio, song.sample_rate, song.beats, song.downbeats, beat_confidence=0.2
    ).result
    assert result.lowConfidence is True


# --- the capability ------------------------------------------------------------------------


def test_the_capability_name_and_params_follow_the_dag() -> None:
    assert structure_capability.CAPABILITY == "analysis.structure"
    with pytest.raises(ValueError, match="tracker"):
        structure_capability.ParamsModel.model_validate({"tracker": "madmom"})


def _rhythm_blob(song: synthetic_songs.SyntheticSong) -> bytes:
    return (
        RhythmResult.model_validate(
            {
                "schemaVersion": 1,
                "bpm": 120.0,
                "beats": song.beats.tolist(),
                "downbeats": song.downbeats.tolist(),
                "tempoCurve": [{"beat": i, "bpm": 120.0} for i in range(song.beats.size)],
                "timeSignature": {"numerator": 4, "denominator": 4},
                "confidence": 0.95,
                "isTempoStable": True,
            }
        )
        .model_dump_json(exclude_none=True)
        .encode()
    )


class BlobContext(FakeContext):
    """A context whose ``download`` knows the audio and one rhythm blob."""

    def __init__(self, scratch: Path, audio: bytes, blobs: dict[str, bytes]) -> None:
        super().__init__(scratch, audio)
        self.blobs = blobs

    async def download(self, content_hash: str) -> bytes:
        return self.blobs.get(content_hash, self.source)


@needs_ffmpeg
def test_capability_publishes_a_structure_blob_from_the_rhythm_blob(tmp_path: Path) -> None:
    song = synthetic_songs.render_song(
        "cap", [("verse", 8), ("chorus", 8), ("verse", 8), ("chorus", 8)], 120
    )
    rhythm_hash = "sha256:" + "b" * 64
    context = BlobContext(
        tmp_path, wav_bytes(song.audio, song.sample_rate), {rhythm_hash: _rhythm_blob(song)}
    )
    job = make_job("analysis.structure")
    job = job.model_copy(
        update={
            "inputs": JobInputs(
                assets=job.inputs.assets,
                blobs={"rhythm": rhythm_hash},
                params=FreeformParams.model_validate({}),
            )
        }
    )
    outputs = asyncio.run(structure_capability.run(job, cast(JobContext, context)))
    assert outputs.blobs is not None
    blob = json.loads(context.uploads[outputs.blobs["result"]])
    result = StructureResult.model_validate(blob)
    assert [s.kind for s in result.sections] == [
        SectionKind.verse,
        SectionKind.chorus,
        SectionKind.verse,
        SectionKind.chorus,
    ]
    assert result.sections[0].repeatGroup == result.sections[2].repeatGroup
    assert result.sections[1].repeatGroup == result.sections[3].repeatGroup
    assert context.reports[-1] == 1.0


@needs_ffmpeg
def test_capability_tracks_the_beats_itself_without_a_rhythm_blob(tmp_path: Path) -> None:
    song = synthetic_songs.render_song(
        "cap2", [("verse", 8), ("chorus", 8), ("verse", 8), ("chorus", 8)], 120
    )
    context = FakeContext(tmp_path, wav_bytes(song.audio, song.sample_rate))
    outputs = asyncio.run(
        structure_capability.run(
            make_job("analysis.structure", {"tracker": "dsp"}), cast(JobContext, context)
        )
    )
    assert outputs.blobs is not None
    result = StructureResult.model_validate(json.loads(context.uploads[outputs.blobs["result"]]))
    assert len(result.sections) >= 2


# --- the metrics ---------------------------------------------------------------------------

REF = [SECTION(0, 30, "intro"), SECTION(30, 60, "verse"), SECTION(60, 90, "chorus")]


def test_boundary_hit_rate_uses_a_three_second_window() -> None:
    near = [SECTION(0, 32.5, "intro"), SECTION(32.5, 61, "verse"), SECTION(61, 90, "chorus")]
    far = [SECTION(0, 34, "intro"), SECTION(34, 90, "verse")]
    assert metrics.boundary_scores(REF, near)[0] == 1.0
    hit, precision, _ = metrics.boundary_scores(REF, far)
    assert hit == pytest.approx(0.0)
    assert precision == pytest.approx(0.0)
    half = [SECTION(0, 30, "intro"), SECTION(30, 90, "verse")]
    assert metrics.boundary_scores(REF, half)[0] == pytest.approx(0.5)


def test_label_accuracy_is_weighted_by_duration() -> None:
    estimate = [SECTION(0, 30, "intro"), SECTION(30, 60, "chorus"), SECTION(60, 90, "chorus")]
    assert metrics.label_accuracy(REF, estimate) == pytest.approx(2 / 3)
    assert metrics.label_accuracy(REF, REF) == 1.0


def test_chorus_grouping_needs_all_choruses_together_and_apart_from_the_rest() -> None:
    reference = [
        SECTION(0, 10, "verse"),
        SECTION(10, 20, "chorus"),
        SECTION(20, 30, "verse"),
        SECTION(30, 40, "chorus"),
    ]

    def est(groups: str) -> list[metrics.LabelledSection]:
        return [SECTION(10 * i, 10 * i + 10, "x", g) for i, g in enumerate(groups)]

    assert metrics.chorus_grouping_correct(reference, est("ABAB")) is True
    assert metrics.chorus_grouping_correct(reference, est("ABAC")) is False  # choruses split
    assert metrics.chorus_grouping_correct(reference, est("BBBB")) is False  # verses share it
    assert metrics.chorus_grouping_correct(REF, est("ABC")) is None  # < 2 reference choruses


def test_parse_sections_reads_kinds_groups_and_comments() -> None:
    parsed = structure_eval.parse_sections("# song\n0 12.5 intro\n12.5 40 verse A  # first\n")
    assert parsed == [SECTION(0.0, 12.5, "intro"), SECTION(12.5, 40.0, "verse", "A")]
    with pytest.raises(ValueError, match="expected"):
        structure_eval.parse_sections("0 12\n")


# --- gate semantics ------------------------------------------------------------------------


def good(track_id: str = "t", *, grouped: bool | None = True) -> structure_eval.StructureScore:
    return structure_eval.StructureScore(
        track_id, "scored", 0.9, 0.9, 0.8, grouped, sections_found=5, sections_expected=5
    )


def test_structure_gates_are_pending_without_an_eval_set() -> None:
    gates = structure_eval.gates_for([], 0)
    assert {g.status for g in gates} == {"PENDING"}
    assert all(g.value is None for g in gates)  # no number for a set that does not exist


def test_structure_gates_are_pending_unless_every_track_was_scored() -> None:
    gates = structure_eval.gates_for([good(), structure_eval.StructureScore("b", "missing")], 2)
    assert {g.status for g in gates} == {"PENDING"}


def test_structure_gates_pass_and_fail_on_a_complete_set() -> None:
    assert [g.status for g in structure_eval.gates_for([good("a"), good("b")], 2)] == ["PASS"] * 3
    bad = structure_eval.StructureScore("c", "scored", 0.2, 0.2, 0.1, False)
    statuses = {g.name: g.status for g in structure_eval.gates_for([good("a"), bad], 2)}
    assert statuses["boundary hit-rate (+-3 s)"] == "FAIL"  # mean 0.55 < 0.70
    assert statuses["label accuracy"] == "FAIL"  # mean 0.45 < 0.60
    assert statuses["chorus repeat groups"] == "FAIL"  # 1 of 2 songs


def test_the_chorus_gate_is_pending_when_no_song_has_two_choruses() -> None:
    gates = structure_eval.gates_for([good(grouped=None)], 1)
    assert [g.status for g in gates] == ["PASS", "PASS", "PENDING"]


# --- the harness, end to end on generated audio --------------------------------------------


def _write_track(tmp_path: Path, song: synthetic_songs.SyntheticSong) -> dict[str, object]:
    audio_dir = tmp_path / "audio"
    audio_dir.mkdir(exist_ok=True)
    labels_dir = tmp_path / "labels"
    labels_dir.mkdir(exist_ok=True)
    data = wav_bytes(song.audio, song.sample_rate)
    (audio_dir / f"{song.name}.wav").write_bytes(data)
    (labels_dir / f"{song.name}.beats").write_text(
        "\n".join(f"{t:.4f} {i % 4 + 1}" for i, t in enumerate(song.beats))
    )
    (labels_dir / f"{song.name}.sections").write_text(
        "\n".join(f"{s.startSec:.3f} {s.endSec:.3f} {s.kind}" for s in song.sections)
    )
    return {
        "id": song.name,
        "file": f"{song.name}.wav",
        "audioSha256": hashlib.sha256(data).hexdigest(),
        "licence": "generated by the test",
        "labels": {
            "beats": f"labels/{song.name}.beats",
            "sections": f"labels/{song.name}.sections",
        },
    }


def run_cli(tmp_path: Path, tracks: list[dict[str, object]], *extra: str) -> tuple[int, str]:
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps({"schemaVersion": 1, "tracks": tracks}))
    code = harness.main(
        [
            "--manifest",
            str(manifest),
            "--audio-dir",
            str(tmp_path / "audio"),
            "--out-dir",
            str(tmp_path / "reports"),
            "--tracker",
            "dsp",
            *extra,
        ]
    )
    day = datetime.datetime.now(datetime.UTC).date()
    return code, (tmp_path / "reports" / f"analysis-{day}.md").read_text("utf-8")


@needs_ffmpeg
def test_the_harness_scores_structure_from_a_manifest(
    tmp_path: Path, songs: list[synthetic_songs.SyntheticSong]
) -> None:
    tracks = [_write_track(tmp_path, songs[0]), _write_track(tmp_path, songs[2])]
    code, report = run_cli(tmp_path, tracks)
    assert "| song_pop_120bpm | scored |" in report
    assert "| structure | boundary hit-rate (+-3 s) | >= 0.7 | **PASS**" in report
    assert "| structure | chorus repeat groups | >= 0.8 | **PASS**" in report
    assert code == 0


@needs_ffmpeg
def test_a_track_without_section_labels_does_not_count_for_structure(
    tmp_path: Path, songs: list[synthetic_songs.SyntheticSong]
) -> None:
    track = _write_track(tmp_path, songs[0])
    labels_entry = cast(dict[str, str], track["labels"])
    del labels_entry["sections"]
    _, report = run_cli(tmp_path, [track])
    assert "No eval track has a `labels.sections` file" in report
    assert "**PENDING**: no eval track has a section label file" in report


def test_the_synthetic_structure_section_is_labelled_as_not_the_gate(tmp_path: Path) -> None:
    code, report = run_cli(tmp_path, [], "--synthetic")
    assert code == 0
    assert "Synthetic structure harness check (not the gate)" in report
    assert "| song_pop_120bpm |" in report
    assert "**PENDING**" in report
