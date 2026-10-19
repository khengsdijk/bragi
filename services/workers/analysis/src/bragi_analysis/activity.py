"""Per-stem activity gating (``specs/04`` §5.4).

A stem is *active* where its short-time RMS is above a gate. The spec fixes the gate at
-45 dBFS with a 250 ms hop; both are parameters here so the capability can tune them and the
tests can pin the exact arithmetic. Regions separated by less than a hop are closed (a gated
hi-hat must not shatter into a click-track) and runs shorter than a minimum are dropped.

The whole module is pure NumPy over a mono signal, so it is tested on generated audio.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

type F64 = NDArray[np.float64]

#: 04 §5.4: the gate and its hop.
GATE_DB = -45.0
HOP_SEC = 0.25
#: Runs shorter than this are noise; gaps shorter than this are closed.
MIN_RUN_SEC = HOP_SEC
MERGE_GAP_SEC = HOP_SEC
#: dBFS floor for digital silence (JSON has no -inf).
SILENCE_DB = -120.0


@dataclass(frozen=True)
class Section:
    """A section span the presence series is reported over."""

    index: int
    start_sec: float
    end_sec: float


def frame_rms_db(mono: NDArray[np.floating], sample_rate: int, hop_sec: float = HOP_SEC) -> F64:
    """Per-hop RMS in dBFS, hops of exactly ``hop_sec`` (a partial tail is dropped)."""
    hop = max(1, round(hop_sec * sample_rate))
    frames = mono.shape[0] // hop
    if frames == 0:
        return np.zeros(0, dtype=np.float64)
    trimmed = np.asarray(mono[: frames * hop], dtype=np.float64).reshape(frames, hop)
    rms = np.sqrt(np.mean(trimmed**2, axis=1))
    return np.maximum(20.0 * np.log10(rms + 1e-12), SILENCE_DB)


def _open_runs(open_flags: NDArray[np.bool_]) -> list[tuple[int, int]]:
    """``[start, end)`` frame index runs of ``True``."""
    runs: list[tuple[int, int]] = []
    start: int | None = None
    for index, flag in enumerate(open_flags):
        if flag and start is None:
            start = index
        elif not flag and start is not None:
            runs.append((start, index))
            start = None
    if start is not None:
        runs.append((start, len(open_flags)))
    return runs


def gated_regions(
    rms_db: F64,
    hop_sec: float = HOP_SEC,
    *,
    gate_db: float = GATE_DB,
    merge_gap_sec: float = MERGE_GAP_SEC,
    min_run_sec: float = MIN_RUN_SEC,
) -> list[tuple[float, float]]:
    """The active ``(startSec, endSec)`` regions of a gated RMS series."""
    runs = _open_runs(rms_db >= gate_db)
    if not runs:
        return []
    merged: list[list[float]] = [[float(runs[0][0]), float(runs[0][1])]]
    for start, end in runs[1:]:
        gap_sec = (start - merged[-1][1]) * hop_sec
        if gap_sec <= merge_gap_sec:
            merged[-1][1] = float(end)
        else:
            merged.append([float(start), float(end)])
    return [
        (start * hop_sec, end * hop_sec)
        for start, end in merged
        if (end - start) * hop_sec >= min_run_sec
    ]


def presence(
    rms_db: F64,
    sections: Sequence[Section],
    hop_sec: float = HOP_SEC,
    *,
    gate_db: float = GATE_DB,
) -> list[tuple[int, float]]:
    """The share of open hops inside each section, 0..1 (04 §5.4).

    A hop belongs to the section holding its centre, so the sections tile the song exactly.
    """
    if rms_db.size == 0 or not sections:
        return [(section.index, 0.0) for section in sections]
    centres = (np.arange(rms_db.size) + 0.5) * hop_sec
    open_flags = rms_db >= gate_db
    out: list[tuple[int, float]] = []
    for section in sections:
        inside = (centres >= section.start_sec) & (centres < section.end_sec)
        total = int(inside.sum())
        share = float(open_flags[inside].sum()) / total if total else 0.0
        out.append((section.index, share))
    return out


@dataclass(frozen=True)
class StemActivity:
    """One stem's gated regions and per-section presence (schema ``StemActivity``)."""

    role: str
    active: list[tuple[float, float]]
    presence: list[tuple[int, float]]


def analyse_stem(
    role: str,
    mono: NDArray[np.floating],
    sample_rate: int,
    sections: Sequence[Section],
    *,
    gate_db: float = GATE_DB,
    hop_sec: float = HOP_SEC,
) -> StemActivity:
    """Gates one stem and reports its regions and per-section presence."""
    rms_db = frame_rms_db(mono, sample_rate, hop_sec)
    return StemActivity(
        role=role,
        active=gated_regions(rms_db, hop_sec, gate_db=gate_db),
        presence=presence(rms_db, sections, hop_sec, gate_db=gate_db),
    )


def analyse_stems(
    stems: Mapping[str, NDArray[np.floating]],
    sample_rate: int,
    sections: Sequence[Section],
    *,
    gate_db: float = GATE_DB,
    hop_sec: float = HOP_SEC,
) -> list[StemActivity]:
    """Gates every stem, in the order given."""
    return [
        analyse_stem(role, mono, sample_rate, sections, gate_db=gate_db, hop_sec=hop_sec)
        for role, mono in stems.items()
    ]


__all__ = [
    "GATE_DB",
    "HOP_SEC",
    "MERGE_GAP_SEC",
    "MIN_RUN_SEC",
    "Section",
    "StemActivity",
    "analyse_stem",
    "analyse_stems",
    "frame_rms_db",
    "gated_regions",
    "presence",
]
