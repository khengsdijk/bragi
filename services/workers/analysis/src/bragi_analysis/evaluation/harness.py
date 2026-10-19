"""The analysis eval harness behind ``pnpm eval:analysis`` (``specs/04`` §8).

It reads ``fixtures/eval/manifest.json``, runs the rhythm stage on every track
whose audio has been fetched (``scripts/fetch-eval.sh``), scores the beats and
writes ``reports/analysis-<date>.md``.

It never invents a number. A gate is **PASS** or **FAIL** only when *every* track
in the manifest was scored; with no audio (today: no eval set exists) the verdict
is **PENDING** and the report says so. The synthetic suite proves the machinery
and is reported in its own section, never as the gate.
"""

from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import hashlib
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import numpy as np
from numpy.typing import NDArray
from pydantic import BaseModel, ConfigDict

from bragi_analysis import media, rhythm_post, trackers
from bragi_analysis.evaluation import metrics, synthetic
from bragi_analysis.trackers.base import TRACKER_SAMPLE_RATE, BeatTracker

type F64 = NDArray[np.float64]

GateStatus = Literal["PASS", "FAIL", "PENDING"]


class LabelFiles(BaseModel):
    """Hand-labelled ground truth, paths relative to the manifest's directory."""

    model_config = ConfigDict(extra="forbid")

    #: Text file, one beat per line: ``<seconds>`` or ``<seconds> <position in bar>``.
    #: A position of 1 marks a downbeat.
    beats: str


class EvalTrack(BaseModel):
    """One eval track. The audio is referenced by hash and never committed."""

    model_config = ConfigDict(extra="forbid")

    id: str
    #: File name inside the fetched audio directory.
    file: str
    audioSha256: str  # noqa: N815 - the manifest's field name
    licence: str
    genre: str | None = None
    labels: LabelFiles


class Manifest(BaseModel):
    """``fixtures/eval/manifest.json``."""

    model_config = ConfigDict(extra="forbid")

    schemaVersion: Literal[1]  # noqa: N815
    description: str = ""
    tracks: list[EvalTrack]


@dataclass(frozen=True)
class TrackScore:
    """The outcome for one track."""

    id: str
    status: Literal["scored", "missing", "hash_mismatch", "error"]
    beat_f: float | None = None
    downbeat_f: float | None = None
    bpm: float | None = None
    detail: str = ""


@dataclass(frozen=True)
class Gate:
    """A gate verdict with the reason it is what it is."""

    status: GateStatus
    mean_f: float | None
    scored: int
    total: int
    reason: str


@dataclass
class Report:
    """Everything the markdown report is rendered from."""

    day: dt.date
    tracker_name: str
    stage_version: str
    eval_scores: list[TrackScore] = field(default_factory=list)
    gate: Gate | None = None
    synthetic_scores: list[TrackScore] = field(default_factory=list)


def repo_root(start: Path | None = None) -> Path:
    """The repository root: the nearest parent holding ``pnpm-workspace.yaml``."""
    here = (start or Path(__file__)).resolve()
    for parent in [here, *here.parents]:
        if (parent / "pnpm-workspace.yaml").is_file():
            return parent
    raise FileNotFoundError("pnpm-workspace.yaml not found above " + str(here))


def parse_beats(text: str) -> tuple[F64, F64]:
    """Beats and downbeats from a ``.beats`` text file."""
    beats: list[float] = []
    downbeats: list[float] = []
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        fields = line.replace(",", " ").split()
        time = float(fields[0])
        beats.append(time)
        if len(fields) > 1 and float(fields[1]) == 1.0:
            downbeats.append(time)
    return np.asarray(beats), np.asarray(downbeats)


def gate_for(scores: list[TrackScore], total: int, threshold: float) -> Gate:
    """PASS/FAIL only when every manifest track was scored, otherwise PENDING."""
    scored = [s for s in scores if s.status == "scored" and s.beat_f is not None]
    if total == 0:
        return Gate(
            "PENDING", None, 0, 0, "the manifest lists no tracks: the eval set does not exist yet"
        )
    if len(scored) < total:
        return Gate(
            "PENDING",
            None,
            len(scored),
            total,
            f"only {len(scored)} of {total} eval tracks could be scored "
            "(audio not fetched, hash mismatch or error)",
        )
    mean = float(np.mean([s.beat_f for s in scored if s.beat_f is not None]))
    if mean >= threshold:
        return Gate("PASS", mean, total, total, f"mean beat F {mean:.3f} >= {threshold}")
    return Gate("FAIL", mean, total, total, f"mean beat F {mean:.3f} < {threshold}")


def _score(
    track_id: str,
    tracker: BeatTracker,
    mono: NDArray[np.float32],
    sample_rate: int,
    ref_beats: F64,
    ref_downbeats: F64,
) -> TrackScore:
    estimate = tracker.track(mono, sample_rate)
    result = rhythm_post.build_result(
        estimate.beats, estimate.downbeats, mono.shape[0] / sample_rate
    )
    # Score the post-processed grid: it is what the product publishes.
    beats = np.asarray(result.beats)
    downbeats = np.asarray(result.downbeats)
    return TrackScore(
        id=track_id,
        status="scored",
        beat_f=metrics.beat_f_measure(ref_beats, beats),
        downbeat_f=metrics.beat_f_measure(ref_downbeats, downbeats) if ref_downbeats.size else None,
        bpm=result.bpm,
    )


def score_synthetic(tracker: BeatTracker) -> list[TrackScore]:
    """Scores the synthetic suite, which has exact ground truth."""
    return [
        _score(t.name, tracker, t.audio, t.sample_rate, t.beats, t.downbeats)
        for t in synthetic.suite()
    ]


async def _score_eval_track(
    track: EvalTrack, manifest_dir: Path, audio_dir: Path, tracker: BeatTracker
) -> TrackScore:
    audio = audio_dir / track.file
    if not audio.is_file():
        return TrackScore(
            track.id, "missing", detail=f"{audio} not found (run scripts/fetch-eval.sh)"
        )
    digest = hashlib.sha256(audio.read_bytes()).hexdigest()
    if digest != track.audioSha256.removeprefix("sha256:"):
        return TrackScore(track.id, "hash_mismatch", detail=f"sha256 is {digest}")
    try:
        ref_beats, ref_downbeats = parse_beats(
            (manifest_dir / track.labels.beats).read_text("utf-8")
        )
        info = await media.probe(audio)
        pcm = await media.decode_pcm(
            audio,
            sample_rate=TRACKER_SAMPLE_RATE,
            channels=1,
            declared_duration_sec=info.duration_sec,
        )
        return await asyncio.to_thread(
            _score, track.id, tracker, pcm[:, 0], TRACKER_SAMPLE_RATE, ref_beats, ref_downbeats
        )
    except Exception as error:  # report it, keep scoring the rest
        return TrackScore(track.id, "error", detail=f"{type(error).__name__}: {error}")


async def score_manifest(
    manifest: Manifest, manifest_dir: Path, audio_dir: Path, tracker: BeatTracker
) -> list[TrackScore]:
    """Scores every manifest track sequentially (the set is ~50 tracks)."""
    return [await _score_eval_track(t, manifest_dir, audio_dir, tracker) for t in manifest.tracks]


def _fmt(value: float | None, digits: int = 3) -> str:
    return "n/a" if value is None else f"{value:.{digits}f}"


def render(report: Report) -> str:
    """The markdown report."""
    gate = report.gate
    assert gate is not None  # noqa: S101 - set by main() before rendering
    lines = [
        f"# Analysis eval report, {report.day.isoformat()}",
        "",
        f"- Tracker: `{report.tracker_name}` (`{report.stage_version}`)",
        f"- Metric: beat F-measure, +-{metrics.BEAT_TOLERANCE_SEC * 1000:.0f} ms, `mir_eval`; "
        f"gate >= {metrics.BEAT_F_GATE} (04 section 8)",
        "",
        "## Gates",
        "",
        "| Stage | Metric | Gate | Result |",
        "|---|---|---|---|",
        f"| rhythm | beat F-measure | >= {metrics.BEAT_F_GATE} "
        f"| **{gate.status}**: {gate.reason} |",
        "| separation | SDR per stem | report only | not implemented in WP-1.2 |",
        "| structure | boundary hit-rate, label accuracy | >= 0.70, >= 0.60 "
        "| not implemented in WP-1.2 |",
        "| harmony | chord accuracy, key accuracy | >= 0.70, >= 0.80 | not implemented in WP-1.2 |",
        "| tag | top-3 genre agreement | >= 0.70 | not implemented in WP-1.2 |",
        "| describe | manual checklist | 0 hard failures | not implemented in WP-1.2 |",
        "",
        "## Rhythm on the eval set",
        "",
    ]
    if not report.eval_scores:
        lines += [
            "No eval tracks: `fixtures/eval/manifest.json` lists none. "
            "**No numbers are reported.**",
            "",
        ]
    else:
        lines += [
            "| Track | Status | Beat F | Downbeat F | bpm | Detail |",
            "|---|---|---|---|---|---|",
        ]
        lines += [
            f"| {s.id} | {s.status} | {_fmt(s.beat_f)} | {_fmt(s.downbeat_f)} "
            f"| {_fmt(s.bpm, 1)} | {s.detail} |"
            for s in report.eval_scores
        ]
        if gate.mean_f is not None:
            lines += ["", f"Mean beat F over {gate.total} tracks: **{gate.mean_f:.3f}**"]
        lines.append("")
    if report.synthetic_scores:
        scored = [s.beat_f for s in report.synthetic_scores if s.beat_f is not None]
        lines += [
            "## Synthetic harness check (not the gate)",
            "",
            "Generated click tracks with exact ground truth. They prove the harness and the "
            "post-processing, not the model's accuracy on music.",
            "",
            "| Track | Beat F | Downbeat F | bpm |",
            "|---|---|---|---|",
        ]
        lines += [
            f"| {s.id} | {_fmt(s.beat_f)} | {_fmt(s.downbeat_f)} | {_fmt(s.bpm, 1)} |"
            for s in report.synthetic_scores
        ]
        lines += [
            "",
            f"Mean beat F over {len(scored)} synthetic tracks: {float(np.mean(scored)):.3f}",
            "",
        ]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    """CLI entry. Exit code: 0 unless a gate FAILs (or, with ``--strict``, is PENDING)."""
    root = repo_root()
    parser = argparse.ArgumentParser(prog="eval:analysis", description=__doc__)
    parser.add_argument("--manifest", type=Path, default=root / "fixtures/eval/manifest.json")
    parser.add_argument("--audio-dir", type=Path, default=root / "fixtures/eval/audio")
    parser.add_argument("--out-dir", type=Path, default=root / "reports")
    parser.add_argument("--tracker", choices=["auto", "beat_this", "dsp"], default="auto")
    parser.add_argument("--synthetic", action="store_true", help="also score the synthetic suite")
    parser.add_argument(
        "--allow-fallback-gate",
        action="store_true",
        help="let the weight-free DSP fallback decide the gate (tests only; v1 gates Beat This!)",
    )
    parser.add_argument(
        "--strict", action="store_true", help="exit non-zero unless the gate PASSes"
    )
    args = parser.parse_args(argv)

    manifest = Manifest.model_validate(json.loads(args.manifest.read_text("utf-8")))
    tracker = trackers.select(args.tracker)
    report = Report(
        day=dt.datetime.now(dt.UTC).date(),
        tracker_name=tracker.name,
        stage_version=tracker.stage_version,
    )
    report.eval_scores = asyncio.run(
        score_manifest(manifest, args.manifest.parent, args.audio_dir, tracker)
    )
    report.gate = gate_for(report.eval_scores, len(manifest.tracks), metrics.BEAT_F_GATE)
    if (
        tracker.name != "beat_this"
        and not args.allow_fallback_gate
        and report.gate.status != "PENDING"
    ):
        report.gate = Gate(
            "PENDING",
            report.gate.mean_f,
            report.gate.scored,
            report.gate.total,
            f"scored with the `{tracker.name}` fallback, which is not the v1 model "
            "(set BRAGI_BEAT_THIS_CHECKPOINT and use the `ml` extra)",
        )
    if args.synthetic:
        report.synthetic_scores = score_synthetic(tracker)

    args.out_dir.mkdir(parents=True, exist_ok=True)
    out = args.out_dir / f"analysis-{report.day.isoformat()}.md"
    out.write_text(render(report), "utf-8")
    print(f"rhythm gate: {report.gate.status} ({report.gate.reason})")
    print(f"report: {out}")
    if report.gate.status == "FAIL":
        return 1
    if args.strict and report.gate.status != "PASS":
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
