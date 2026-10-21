"""Step 2 of 09 §6: tempo conform.

Beat-track the candidate at the analysis worker's tracker rate (22.05 kHz),
compare it with the requested BPM and time-stretch to that tempo. Half and
double time count as the same tempo (a model asked for 120 BPM may generate a
half-time feel); the stretch then only removes the residual error inside the
matched multiple, so a half-time candidate is not replayed at double speed.

The stretch is WSOLA (:mod:`bragi_generate.postprocess.stretch`): no
resampling, no phase vocoder, deterministic.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

from bragi_analysis.harmony.chroma import resample_mono
from bragi_analysis.trackers.base import TRACKER_SAMPLE_RATE
from bragi_analysis.trackers.dsp import DspTracker, estimate_tempo
from bragi_generate.postprocess import onsets
from bragi_generate.postprocess.config import GateConfig
from bragi_generate.postprocess.stretch import time_stretch
from bragi_generate.postprocess.types import Audio, GateRequest, StepVerdict

type F64 = NDArray[np.float64]
type F32 = NDArray[np.float32]

#: Tempo multiples that are musically the same tempo (09 §6: half/double time).
MULTIPLES: tuple[float, ...] = (0.5, 1.0, 2.0)


@dataclass(frozen=True)
class TempoResult:
    """The verdict plus what later steps need: audio and its beats."""

    verdict: StepVerdict
    audio: Audio
    tempo_bpm: float
    multiple: float
    beats_sec: F64


def _at_tracker_rate(audio: Audio) -> F32:
    if audio.sample_rate == TRACKER_SAMPLE_RATE:
        return audio.mono
    return resample_mono(audio.mono, audio.sample_rate, TRACKER_SAMPLE_RATE)


def beat_times(audio: Audio) -> tuple[float, F64]:
    """Detected tempo in BPM and beat times in seconds, at the tracker rate."""
    mono = _at_tracker_rate(audio)
    envelope, fps = onsets.envelope(mono, TRACKER_SAMPLE_RATE)
    tempo = estimate_tempo(envelope, fps)
    estimate = DspTracker().track(mono, TRACKER_SAMPLE_RATE)
    beats = np.asarray(estimate.beats, dtype=np.float64)
    if beats.size < 2:
        period = 60.0 / tempo
        beats = np.arange(0.0, audio.duration_sec, period, dtype=np.float64)
    return float(tempo), beats


def conform(audio: Audio, req: GateRequest, cfg: GateConfig) -> TempoResult:
    """Tracks, rejects a >4 % error and warps the rest onto the requested grid."""
    empty = TempoResult(
        StepVerdict("tempo", False, {"tempo_bpm": 0.0}, "no pulse"),
        audio,
        0.0,
        1.0,
        np.zeros(0),
    )
    tempo, beats = beat_times(audio)
    if not np.isfinite(tempo) or tempo <= 0.0 or beats.size < 2:
        return empty
    ratio = tempo / req.bpm
    multiple = min(MULTIPLES, key=lambda value: abs(float(np.log2(ratio / value))))
    error = abs(ratio / multiple - 1.0)
    metrics = {
        "tempo_bpm": round(tempo, 3),
        "requested_bpm": req.bpm,
        "multiple": multiple,
        "tempo_error": round(error, 5),
        "beats": int(beats.size),
    }
    if error > cfg.tempo_max_error:
        return TempoResult(
            StepVerdict("tempo", False, metrics, "tempo error above the gate"),
            audio,
            tempo,
            multiple,
            beats,
        )

    factor = ratio / multiple
    stretched = time_stretch(audio.samples, factor, audio.sample_rate)
    warped = Audio(np.ascontiguousarray(stretched, dtype=np.float32), audio.sample_rate)
    return TempoResult(
        StepVerdict("tempo", True, metrics | {"stretch": round(factor, 5)}),
        warped,
        tempo,
        multiple,
        np.asarray(beats * factor, dtype=np.float64),
    )
