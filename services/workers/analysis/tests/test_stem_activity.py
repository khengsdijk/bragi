"""The stem gate: thresholds, hop, gap merging and per-section presence (04 §5.4)."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import cast

import numpy as np
import pytest
from embedding_support import FakeContext, make_job, needs_ffmpeg, sine, wav_bytes

from bragi_analysis import activity
from bragi_analysis.activity import Section
from bragi_analysis.capabilities import stem_activity
from bragi_analysis.capabilities.stem_activity import STEM_RATE
from bragi_common.cancel import JobCancelledError
from bragi_common.context import JobContext
from bragi_common.generated.models import StemActivityResult, StemRole

HASH_A = "sha256:" + "a" * 64
HASH_B = "sha256:" + "b" * 64


def test_frame_rms_is_dbfs_with_the_gate_hop() -> None:
    sample_rate = 8000
    full_scale = sine(1.0, sample_rate, 100.0, amplitude=1.0)
    levels = activity.frame_rms_db(full_scale, sample_rate)
    assert levels.shape[0] == 4  # 1 s at a 250 ms hop
    assert float(levels[0]) == pytest.approx(-3.01, abs=0.05)  # a full-scale sine
    assert float(activity.frame_rms_db(np.zeros(sample_rate, np.float32), sample_rate)[0]) == (
        pytest.approx(activity.SILENCE_DB)
    )


def test_gated_regions_threshold_hop_and_gap_merging() -> None:
    hop = 0.25
    # threshold: -44 dB is open, -46 dB is not at the -45 dB gate
    assert activity.gated_regions(np.asarray([-44.0, -46.0]), hop) == [(0.0, 0.25)]
    # a 250 ms gap is closed: [-40, -60, -40] -> one 0.75 s region
    assert activity.gated_regions(np.asarray([-40.0, -60.0, -40.0]), hop) == [(0.0, 0.75)]
    # a 500 ms gap is not
    assert activity.gated_regions(np.asarray([-40.0, -60.0, -60.0, -40.0]), hop) == [
        (0.0, 0.25),
        (0.75, 1.0),
    ]
    # a run shorter than the minimum is dropped
    assert activity.gated_regions(np.asarray([-40.0]), hop, min_run_sec=0.5) == []


def test_presence_is_the_open_hop_share_per_section() -> None:
    sections = [Section(0, 0.0, 1.0), Section(1, 1.0, 2.0)]
    levels = np.asarray([-40.0, -60.0, -40.0, -60.0, -60.0, -60.0, -40.0, -40.0])
    assert activity.presence(levels, sections, 0.25) == [(0, 0.5), (1, 0.5)]
    assert activity.presence(np.zeros(0), sections, 0.25) == [(0, 0.0), (1, 0.0)]


def test_analyse_stem_on_generated_signals() -> None:
    sample_rate = 8000
    silent = np.zeros(2 * sample_rate, dtype=np.float32)
    tone = np.zeros(2 * sample_rate, dtype=np.float32)
    tone[sample_rate : sample_rate + 4000] = sine(0.5, sample_rate, 200.0, 0.7)
    sections = [Section(0, 0.0, 1.0), Section(1, 1.0, 2.0)]

    quiet = activity.analyse_stem("drums", silent, sample_rate, sections)
    assert quiet.active == []
    assert [presence for _, presence in quiet.presence] == [0.0, 0.0]

    loud = activity.analyse_stem("drums", tone, sample_rate, sections)
    assert len(loud.active) == 1
    start, end = loud.active[0]
    assert start == pytest.approx(1.0, abs=0.3)
    assert end == pytest.approx(1.5, abs=0.3)
    assert [presence for _, presence in loud.presence] == [0.0, 0.5]


def test_capability_contract() -> None:
    assert stem_activity.CAPABILITY == "analysis.stem_activity"
    assert stem_activity.ParamsModel().gateDb == activity.GATE_DB
    assert stem_activity.ParamsModel().hopSec == activity.HOP_SEC
    with pytest.raises(ValueError, match="extra"):
        stem_activity.ParamsModel.model_validate({"nope": 1})


def test_a_missing_input_is_rejected() -> None:
    context = FakeContext(Path(), {})
    with pytest.raises(ValueError, match=r"assets\.stem"):
        asyncio.run(
            stem_activity.run(make_job(stem_activity.CAPABILITY, {}), cast(JobContext, context))
        )


@needs_ffmpeg
def test_capability_gates_stems_and_reports_presence(tmp_path: Path) -> None:
    full = sine(4.0, STEM_RATE, 220.0, 0.6)
    silent = np.zeros(STEM_RATE * 4, dtype=np.float32)
    context = FakeContext(
        tmp_path,
        {
            HASH_A: wav_bytes(full, STEM_RATE),
            HASH_B: wav_bytes(silent, STEM_RATE),
        },
    )
    job = make_job(stem_activity.CAPABILITY, {"stem_drums": HASH_A, "stem_bass": HASH_B})
    outputs = asyncio.run(stem_activity.run(job, cast(JobContext, context)))
    assert outputs.blobs is not None and "stem_activity" in outputs.blobs
    result = StemActivityResult.model_validate_json(context.uploads[outputs.blobs["stem_activity"]])

    assert [stem.role for stem in result.stems] == [StemRole.drums, StemRole.bass]
    drums, bass = result.stems
    assert drums.active and drums.active[0].startSec < 0.5
    assert bass.active == []
    # no structure blob => no presence series
    assert drums.presence == []
    assert context.reports == sorted(context.reports)
    assert context.reports[-1] == 1.0


@needs_ffmpeg
def test_capability_uses_the_structure_blob_for_presence(tmp_path: Path) -> None:
    import json

    audio = wav_bytes(sine(2.0, STEM_RATE, 220.0, 0.6), STEM_RATE)
    structure = {
        "schemaVersion": 1,
        "sections": [
            {"startSec": 0.0, "endSec": 1.0, "kind": "verse", "confidence": 0.9},
            {"startSec": 1.0, "endSec": 2.0, "kind": "chorus", "confidence": 0.9},
        ],
    }
    context = FakeContext(tmp_path, {HASH_A: audio, HASH_B: json.dumps(structure).encode()})
    job = make_job(
        stem_activity.CAPABILITY,
        {"stem_drums": HASH_A},
        blobs={"structure": HASH_B},
    )
    outputs = asyncio.run(stem_activity.run(job, cast(JobContext, context)))
    assert outputs.blobs is not None
    result = StemActivityResult.model_validate_json(context.uploads[outputs.blobs["stem_activity"]])
    presence = result.stems[0].presence
    assert [entry.index for entry in presence] == [0, 1]
    assert all(entry.presence > 0.9 for entry in presence)


@needs_ffmpeg
def test_capability_falls_back_to_the_mix_as_other(tmp_path: Path) -> None:
    context = FakeContext(tmp_path, {HASH_A: wav_bytes(sine(2.0, STEM_RATE, 200.0), STEM_RATE)})
    job = make_job(stem_activity.CAPABILITY, {"mix": HASH_A})
    outputs = asyncio.run(stem_activity.run(job, cast(JobContext, context)))
    assert outputs.blobs is not None
    result = StemActivityResult.model_validate_json(context.uploads[outputs.blobs["stem_activity"]])
    assert [stem.role for stem in result.stems] == [StemRole.other]


@needs_ffmpeg
def test_capability_cancels_before_gating(tmp_path: Path) -> None:
    context = FakeContext(
        tmp_path,
        {HASH_A: wav_bytes(sine(2.0, STEM_RATE, 200.0), STEM_RATE)},
        cancel_after=0,
    )
    job = make_job(stem_activity.CAPABILITY, {"stem_drums": HASH_A})
    with pytest.raises(JobCancelledError):
        asyncio.run(stem_activity.run(job, cast(JobContext, context)))
    assert not context.uploads


def test_capability_is_registered_with_the_worker() -> None:
    from bragi_analysis import worker

    assert stem_activity in worker.CAPABILITIES
