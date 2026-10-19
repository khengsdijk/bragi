"""The eval harness: metrics, gate semantics, the report, and the fetch script (WP-1.2)."""

from __future__ import annotations

import datetime
import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest
from analysis_support import needs_ffmpeg, wav_bytes

from bragi_analysis.evaluation import harness, metrics, synthetic

ROOT = harness.repo_root()


def test_beat_f_measure_matches_hand_computed_values() -> None:
    reference = np.arange(0.0, 10.0, 0.5)  # 20 beats
    assert metrics.beat_f_measure(reference, reference) == 1.0
    # Everything 60 ms late is inside the 70 ms window, 80 ms late is outside.
    assert metrics.beat_f_measure(reference, reference + 0.06) == 1.0
    assert metrics.beat_f_measure(reference, reference + 0.08) == 0.0
    # Half the beats found, no false alarms: P = 1, R = 0.5, F = 2/3.
    assert metrics.beat_f_measure(reference, reference[::2]) == pytest.approx(2 / 3)
    # Found everything plus as many extra off-beat estimates: P = 0.5, R = 1, F = 2/3.
    both = np.sort(np.concatenate([reference, reference + 0.25]))
    assert metrics.beat_f_measure(reference, both) == pytest.approx(2 / 3)


def test_beat_f_measure_edge_cases() -> None:
    empty = np.zeros(0)
    assert metrics.beat_f_measure(empty, empty) == 1.0
    assert metrics.beat_f_measure(np.arange(5.0), empty) == 0.0
    assert metrics.beat_f_measure(empty, np.arange(5.0)) == 0.0


def scored(f: float, track_id: str = "t") -> harness.TrackScore:
    return harness.TrackScore(track_id, "scored", beat_f=f)


def test_gate_is_pending_without_an_eval_set() -> None:
    gate = harness.gate_for([], 0, 0.85)
    assert gate.status == "PENDING"
    assert gate.mean_f is None
    assert "does not exist" in gate.reason


def test_gate_is_pending_unless_every_track_was_scored() -> None:
    partial = [scored(0.99), harness.TrackScore("b", "missing")]
    gate = harness.gate_for(partial, 2, 0.85)
    assert gate.status == "PENDING"
    assert gate.mean_f is None  # no number is offered for a partial set
    assert (gate.scored, gate.total) == (1, 2)


def test_gate_passes_and_fails_on_the_mean_of_a_complete_set() -> None:
    assert harness.gate_for([scored(0.9), scored(0.85)], 2, 0.85).status == "PASS"
    failing = harness.gate_for([scored(0.9), scored(0.7)], 2, 0.85)
    assert failing.status == "FAIL"
    assert failing.mean_f == pytest.approx(0.8)


def test_parse_beats_reads_times_positions_and_comments() -> None:
    beats, downbeats = harness.parse_beats(
        "# comment\n0.50 1\n1.00 2\n1.50 3\n2.00 4  # inline\n2.50 1\n\n"
    )
    assert beats.tolist() == [0.5, 1.0, 1.5, 2.0, 2.5]
    assert downbeats.tolist() == [0.5, 2.5]
    plain, none = harness.parse_beats("0.1\n0.6\n")
    assert plain.tolist() == [0.1, 0.6]
    assert none.size == 0


def test_the_checked_in_manifest_is_empty_and_valid() -> None:
    manifest = harness.Manifest.model_validate(
        json.loads((ROOT / "fixtures/eval/manifest.json").read_text("utf-8"))
    )
    assert manifest.schemaVersion == 1
    assert manifest.tracks == []


def run_cli(tmp_path: Path, manifest: dict[str, object], *extra: str) -> tuple[int, str]:
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(json.dumps(manifest))
    code = harness.main(
        [
            "--manifest",
            str(manifest_path),
            "--audio-dir",
            str(tmp_path / "audio"),
            "--out-dir",
            str(tmp_path / "reports"),
            "--tracker",
            "dsp",
            *extra,
        ]
    )
    reports = list((tmp_path / "reports").glob("analysis-*.md"))
    assert len(reports) == 1
    return code, reports[0].read_text("utf-8")


def test_an_empty_manifest_reports_pending_and_no_numbers(tmp_path: Path) -> None:
    code, report = run_cli(tmp_path, {"schemaVersion": 1, "tracks": []})
    assert code == 0
    assert "**PENDING**" in report
    assert "No numbers are reported" in report
    assert "Mean beat F" not in report


def test_strict_mode_fails_while_the_gate_is_pending(tmp_path: Path) -> None:
    code, _ = run_cli(tmp_path, {"schemaVersion": 1, "tracks": []}, "--strict")
    assert code == 2


def test_the_synthetic_section_is_labelled_as_not_the_gate(tmp_path: Path) -> None:
    code, report = run_cli(tmp_path, {"schemaVersion": 1, "tracks": []}, "--synthetic")
    assert code == 0
    assert "Synthetic harness check (not the gate)" in report
    assert "| click_120bpm_4-4 |" in report
    assert "**PENDING**" in report  # synthetic numbers never decide the gate


@needs_ffmpeg
def test_end_to_end_on_generated_audio_with_labels(tmp_path: Path) -> None:
    track = synthetic.click_track(120, 30, sample_rate=44_100)
    audio_dir = tmp_path / "audio"
    audio_dir.mkdir()
    data = wav_bytes(track.audio, 44_100)
    (audio_dir / "click.wav").write_bytes(data)
    labels = tmp_path / "labels"
    labels.mkdir()
    (labels / "click.beats").write_text(
        "\n".join(f"{t:.4f} {i % 4 + 1}" for i, t in enumerate(track.beats))
    )
    entry = {
        "id": "click",
        "file": "click.wav",
        "audioSha256": hashlib.sha256(data).hexdigest(),
        "licence": "generated by the test",
        "labels": {"beats": "labels/click.beats"},
    }
    code, report = run_cli(
        tmp_path, {"schemaVersion": 1, "tracks": [entry]}, "--allow-fallback-gate"
    )
    assert code == 0
    assert "**PASS**" in report
    assert "| click | scored |" in report

    # The fallback tracker is not the v1 model, so without the override it cannot decide the gate.
    (tmp_path / "reports" / f"analysis-{datetime.datetime.now(datetime.UTC).date()}.md").unlink()
    _, report = run_cli(tmp_path, {"schemaVersion": 1, "tracks": [entry]})
    assert "**PENDING**" in report
    assert "fallback" in report


@needs_ffmpeg
def test_a_hash_mismatch_is_reported_and_never_scored(tmp_path: Path) -> None:
    audio_dir = tmp_path / "audio"
    audio_dir.mkdir()
    (audio_dir / "x.wav").write_bytes(wav_bytes(np.zeros(8000, dtype=np.float32), 8000))
    (tmp_path / "x.beats").write_text("0.5\n")
    entry = {
        "id": "x",
        "file": "x.wav",
        "audioSha256": "0" * 64,
        "licence": "generated",
        "labels": {"beats": "x.beats"},
    }
    _, report = run_cli(tmp_path, {"schemaVersion": 1, "tracks": [entry]}, "--allow-fallback-gate")
    assert "hash_mismatch" in report
    assert "**PENDING**" in report


# --- scripts/fetch-eval.sh ------------------------------------------------------------------


@pytest.mark.skipif(shutil.which("bash") is None, reason="needs bash")
def test_fetch_script_fails_clearly_without_credentials() -> None:
    env = {k: v for k, v in os.environ.items() if not k.startswith(("AWS_", "BRAGI_EVAL"))}
    result = subprocess.run(
        ["bash", str(ROOT / "scripts" / "fetch-eval.sh")],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode != 0
    assert "BRAGI_EVAL_BUCKET" in result.stderr
    assert "AWS_ACCESS_KEY_ID" in result.stderr
    assert "PENDING" in result.stderr
