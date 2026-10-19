"""The analysis eval harness behind ``pnpm eval:analysis`` (``specs/04`` §8).

It reads ``fixtures/eval/manifest.json``, runs the rhythm stage on every track
whose audio has been fetched (``scripts/fetch-eval.sh``), scores the beats and
writes ``reports/analysis-<date>.md``.

It also scores the ``structure`` stage (WP-1.4) on tracks that carry a section label file.

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
from bragi_analysis.evaluation import metrics, structure_eval, synthetic
from bragi_analysis.structure import pipeline as structure_pipeline
from bragi_analysis.trackers.base import TRACKER_SAMPLE_RATE, BeatTracker

type F64 = NDArray[np.float64]

GateStatus = Literal["PASS", "FAIL", "PENDING"]


class LabelFiles(BaseModel):
    """Hand-labelled ground truth, paths relative to the manifest's directory."""

    model_config = ConfigDict(extra="forbid")

    #: Text file, one beat per line: ``<seconds>`` or ``<seconds> <position in bar>``.
    #: A position of 1 marks a downbeat.
    beats: str
    #: Text file, one section per line: ``<start> <end> <kind> [group]`` (``SectionKind``).
    #: Optional: only tracks that have it count towards the structure gates (WP-1.4).
    sections: str | None = None


class EvalTrack(BaseModel):
    """One eval track. The audio is referenced by hash and never committed."""

    model_config = ConfigDict(extra="forbid")

    id: str
    #: File name inside the fetched audio directory.
    file: str
    audioSha256: str  # noqa: N815 - the manifest's field name
    #: Where the track came from (free text, optional).
    source: str | None = None
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
    structure_scores: list[structure_eval.StructureScore] = field(default_factory=list)
    structure_total: int = 0
    structure_gates: list[structure_eval.StructureGate] = field(default_factory=list)
    structure_synthetic: list[structure_eval.StructureScore] = field(default_factory=list)


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


async def _score_structure_track(
    track: EvalTrack, manifest_dir: Path, audio_dir: Path, tracker: BeatTracker
) -> structure_eval.StructureScore:
    audio = audio_dir / track.file
    if not audio.is_file():
        return structure_eval.StructureScore(
            track.id, "missing", detail=f"{audio} not found (run scripts/fetch-eval.sh)"
        )
    digest = hashlib.sha256(audio.read_bytes()).hexdigest()
    if digest != track.audioSha256.removeprefix("sha256:"):
        return structure_eval.StructureScore(
            track.id, "hash_mismatch", detail=f"sha256 is {digest}"
        )
    try:
        assert track.labels.sections is not None  # noqa: S101 - callers filter on it
        reference = structure_eval.parse_sections(
            (manifest_dir / track.labels.sections).read_text("utf-8")
        )
        info = await media.probe(audio)
        pcm = await media.decode_pcm(
            audio,
            sample_rate=TRACKER_SAMPLE_RATE,
            channels=1,
            declared_duration_sec=info.duration_sec,
        )
        analysis = await asyncio.to_thread(
            structure_pipeline.analyse_with_tracker, pcm[:, 0], TRACKER_SAMPLE_RATE, tracker
        )
        return structure_eval.score(
            track.id, reference, structure_eval.from_result(analysis.result)
        )
    except Exception as error:  # report it, keep scoring the rest
        return structure_eval.StructureScore(
            track.id, "error", detail=f"{type(error).__name__}: {error}"
        )


async def score_structure_manifest(
    manifest: Manifest, manifest_dir: Path, audio_dir: Path, tracker: BeatTracker
) -> list[structure_eval.StructureScore]:
    """Scores the manifest tracks that carry a section label file."""
    return [
        await _score_structure_track(t, manifest_dir, audio_dir, tracker)
        for t in manifest.tracks
        if t.labels.sections is not None
    ]


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
        "| separation | SDR per stem | report only | not implemented yet |",
        *[
            f"| structure | {g.name} | >= {g.threshold:g} | **{g.status}**: {g.reason} |"
            for g in report.structure_gates
        ],
        "| harmony | chord accuracy, key accuracy | >= 0.70, >= 0.80 "
        "| **PENDING**: the eval set and its chord/key labels do not exist (Q32, Q65) |",
        f"| tag | top-3 genre agreement | >= {metrics.TAG_GENRE_GATE} "
        f"| **PENDING**: needs the eval set and trained heads (Q32, Q67) |",
        f'| embed_* | `"drums"` stem ranking | >= {metrics.EMBED_DRUM_RANK_GATE:.0%} '
        f"| **PENDING**: needs the eval set's per-stem references (Q32) |",
        "| describe | manual checklist | 0 hard failures | not implemented yet |",
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
    lines += _render_structure(report)
    return "\n".join(lines)


def _fmt_bool(value: bool | None) -> str:
    return "n/a" if value is None else ("yes" if value else "no")


def _structure_table(scores: list[structure_eval.StructureScore], with_detail: bool) -> list[str]:
    head = (
        "| Track | Status | Boundary hit-rate | Precision | Label acc. "
        "| Choruses grouped | Sections (found/ref) |"
    )
    lines = [
        head + (" Detail |" if with_detail else ""),
        "|---|---|---|---|---|---|---|" + ("---|" if with_detail else ""),
    ]
    for s in scores:
        row = (
            f"| {s.id} | {s.status} | {_fmt(s.boundary_hit_rate)} | {_fmt(s.boundary_precision)} "
            f"| {_fmt(s.label_accuracy)} | {_fmt_bool(s.chorus_grouping)} "
            f"| {s.sections_found}/{s.sections_expected} |"
        )
        lines.append(row + (f" {s.detail} |" if with_detail else ""))
    return lines


def _render_structure(report: Report) -> list[str]:
    lines = ["## Structure on the eval set", ""]
    if not report.structure_scores:
        lines += [
            "No eval track has a `labels.sections` file: **no numbers are reported.**",
            "",
        ]
    else:
        lines += [*_structure_table(report.structure_scores, with_detail=True), ""]
    if report.structure_synthetic:
        hits = [
            s.boundary_hit_rate
            for s in report.structure_synthetic
            if s.boundary_hit_rate is not None
        ]
        accs = [
            s.label_accuracy for s in report.structure_synthetic if s.label_accuracy is not None
        ]
        lines += [
            "## Synthetic structure harness check (not the gate)",
            "",
            "Generated songs with a known section plan (`evaluation/synthetic_songs.py`). They "
            "prove "
            "the metrics, snapping, grouping and wiring, not accuracy on real music: the generator "
            "and the segmenter were written by the same hand.",
            "",
            *_structure_table(report.structure_synthetic, with_detail=False),
            "",
            f"Mean boundary hit-rate {float(np.mean(hits)):.3f}, mean label accuracy "
            f"{float(np.mean(accs)):.3f} over {len(hits)} synthetic songs.",
            "",
        ]
    return lines


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
    report.structure_total = sum(1 for t in manifest.tracks if t.labels.sections is not None)
    report.structure_scores = asyncio.run(
        score_structure_manifest(manifest, args.manifest.parent, args.audio_dir, tracker)
    )
    report.structure_gates = structure_eval.gates_for(
        report.structure_scores, report.structure_total
    )
    if args.synthetic:
        report.synthetic_scores = score_synthetic(tracker)
        report.structure_synthetic = structure_eval.score_synthetic()

    args.out_dir.mkdir(parents=True, exist_ok=True)
    out = args.out_dir / f"analysis-{report.day.isoformat()}.md"
    out.write_text(render(report), "utf-8")
    print(f"rhythm gate: {report.gate.status} ({report.gate.reason})")
    for g in report.structure_gates:
        print(f"structure gate, {g.name}: {g.status} ({g.reason})")
    print(f"report: {out}")
    statuses = [report.gate.status, *(g.status for g in report.structure_gates)]
    if "FAIL" in statuses:
        return 1
    if args.strict and any(status != "PASS" for status in statuses):
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
