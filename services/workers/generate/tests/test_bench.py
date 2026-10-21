"""The generation bench runner and its fixtures (09 §9 check 1, docs/wp/2.7.md F1)."""

from __future__ import annotations

import json
import os
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from bragi_generate import routing
from bragi_generate.bench import fixtures, runner
from bragi_generate.bench.report import BenchReport, FixtureReport, check_one

RATE = 48_000


def test_the_five_fixtures_are_distinct_and_long_enough() -> None:
    assert len(fixtures.FIXTURES) == 5
    assert len({fixture.id for fixture in fixtures.FIXTURES}) == 5
    shapes = {
        (fixture.bpm, fixture.time_signature, fixture.key_label) for fixture in fixtures.FIXTURES
    }
    assert len(shapes) == 5
    for fixture in fixtures.FIXTURES:
        assert fixture.duration_sec >= 60.0, fixture.id
        assert fixture.context_sec <= 31.0, fixture.id
        assert fixture.context_bars < fixture.bars, fixture.id


def test_rendering_is_deterministic() -> None:
    fixture = fixtures.by_id("pop")
    first = fixture.render(RATE)
    second = fixture.render(RATE)
    assert first.frames == second.frames
    assert np.array_equal(first.samples, second.samples)
    assert first.sample_rate == RATE
    assert first.samples.shape[1] == 2


def test_the_context_is_the_songs_tail_on_a_bar_line() -> None:
    for fixture in fixtures.FIXTURES:
        song = fixture.render(RATE)
        context = fixture.context_audio(RATE)
        start = round((fixture.bars - fixture.context_bars) * fixture.bar_sec * RATE)
        assert np.array_equal(context.samples, song.samples[start:])
        # Frame rounding can differ from the exact bar length by less than a sample.
        assert abs(context.duration_sec - fixture.context_sec) < 1e-3


def test_fixture_selection_accepts_ids_and_globs() -> None:
    assert [fixture.id for fixture in fixtures.select("pop,rock")] == ["pop", "rock"]
    assert [fixture.id for fixture in fixtures.select("p*")] == ["pop"]
    assert fixtures.select(None) == fixtures.FIXTURES
    with pytest.raises(KeyError, match="unknown fixture"):
        fixtures.by_id("polka")
    with pytest.raises(KeyError, match="no fixture matches"):
        fixtures.select("polka")


def test_the_runner_smoke_test_runs_the_fake_backend_on_one_fixture(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """One fixture, one candidate, no model: the harness end to end (09 §9 check 1)."""
    code = runner.main(
        ["--backend", "fake", "--fixtures", "pop", "--n", "1", "--out", str(tmp_path)]
    )
    assert code == 0
    reports = sorted(tmp_path.glob("generate-*.json"))
    assert len(reports) == 1
    report = BenchReport.model_validate_json(reports[0].read_text(encoding="utf-8"))
    assert report.backend == "fake"
    assert report.tier == "preview"
    assert report.n == 1
    assert len(report.fixtures) == 1
    fixture = report.fixtures[0]
    assert fixture.id == "pop"
    assert fixture.passing == 1
    assert len(fixture.candidates) == 1
    assert fixture.candidates[0].passed
    assert fixture.candidates[0].seam_score is not None
    assert fixture.candidates[0].asset is not None
    assert fixture.candidates[0].blob is not None
    assert fixture.time_to_first_pass_sec is not None
    assert fixture.attempts[0].steps["final_seam"] == "pass"
    # A partial run cannot decide check 1; it says so instead of pretending (09 §9).
    assert report.aggregates.check1 == "PENDING"
    assert "needs 5 songs" in report.aggregates.check1_detail
    assert report.aggregates.step_rates[-1].step == "final_seam"
    assert report.machine
    assert "not the reference GPU" in report.timing_label
    assert "pop" in capsys.readouterr().out


def test_keep_audio_writes_blind_splice_previews(tmp_path: Path) -> None:
    options = runner.BenchOptions(
        backend="fake",
        fixtures="waltz",
        n=1,
        out=tmp_path,
        keep_audio=True,
        quiet=True,
    )
    report = runner.run_bench(options)
    assert report.audio_dir is not None
    audio = Path(report.audio_dir)
    candidate = report.fixtures[0].candidates[0]
    assert candidate.candidate_wav is not None
    assert candidate.splice_wav is not None
    assert Path(candidate.candidate_wav).is_file()
    assert Path(candidate.splice_wav).is_file()
    assert (audio / "sources" / "waltz.wav").is_file()
    order = json.loads((audio / "listening-order.json").read_text(encoding="utf-8"))
    assert [entry["label"] for entry in order["entries"]] == ["A"]
    assert order["entries"][0]["fixture"] == "waltz"
    # The preview is the context plus the new audio, not just the candidate.
    fixture_report = report.fixtures[0]
    preview, _ = sf.read(candidate.splice_wav)
    assert len(preview) / RATE > fixture_report.context_sec


def test_a_partial_run_is_pending_and_a_full_one_decides_check_one() -> None:
    def fixture(fixture_id: str, passing: int) -> FixtureReport:
        return FixtureReport(
            id=fixture_id,
            title=fixture_id,
            bpm=120.0,
            time_signature=[4, 4],
            key_requested="A minor",
            bars=8,
            context_bars=15,
            context_sec=30.0,
            passing=passing,
            total_sec=1.0,
        )

    assert check_one([fixture("pop", 3)], 3)[0] == "PENDING"
    four = [fixture(name, 2) for name in ("pop", "hiphop", "house", "waltz")]
    five = [*four, fixture("rock", 1)]
    assert check_one(five, 3)[0] == "PASS"
    five[0] = fixture("pop", 1)
    assert check_one(five, 3)[0] == "FAIL"


def test_the_default_output_directory_is_the_repository_root() -> None:
    """`uv run --directory` changes cwd, so the default must not follow it."""
    options = runner.parse_args(["--backend", "fake"])
    assert options.out.is_absolute()
    assert options.out.name == "bench-results"
    assert (options.out.parent / "config" / "generation_routes.yaml").is_file()


def test_a_run_restores_the_backend_override(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(routing.ENV_OVERRIDE, "ace_step")
    options = runner.BenchOptions(backend="fake", fixtures="pop", n=1, out=tmp_path, quiet=True)
    runner.run_bench(options)
    assert os.environ[routing.ENV_OVERRIDE] == "ace_step"
