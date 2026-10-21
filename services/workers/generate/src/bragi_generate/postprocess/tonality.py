"""Step 3 of 09 §6: key check, with the ±1 semitone repair.

Key estimation reuses the analysis worker's Krumhansl-Schmuckler fit over its
own chroma (``bragi_analysis.harmony``), so the gate and the harmony capability
disagree only if the audio does.

Pass rules, in order:

- the same key, or (config) the relative key — C major ↔ A minor;
- a tonic one semitone away in the same mode is corrected by a pitch shift of
  that semitone (WSOLA stretch + resample back, :mod:`.stretch`), then passes;
- anything else is rejected.

Confidence is logged but never rejects on its own: a quiet, unison-heavy
candidate may have a flat chroma while still being in the right key.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import numpy as np

from bragi_analysis.harmony.chroma import chroma_frames
from bragi_analysis.harmony.key import estimate_key
from bragi_generate.postprocess.config import GateConfig
from bragi_generate.postprocess.stretch import pitch_shift
from bragi_generate.postprocess.types import (
    RELATIVE_MAJOR_TO_MINOR,
    RELATIVE_MINOR_TO_MAJOR,
    Audio,
    GateRequest,
    KeyMatch,
    KeySpec,
    MetricValue,
    Mode,
    StepVerdict,
)


@dataclass(frozen=True)
class KeyResult:
    """The verdict, the (possibly shifted) audio and the relation it found."""

    verdict: StepVerdict
    audio: Audio
    match: KeyMatch


def detect(audio: Audio) -> tuple[KeySpec, float]:
    """The estimated key of a candidate and its confidence."""
    frames = chroma_frames(audio.mono, audio.sample_rate)
    estimate = estimate_key(frames.vectors, frames.energy)
    mode: Mode = "minor" if estimate.mode == "minor" else "major"
    return KeySpec(estimate.tonic_pc, mode), float(estimate.confidence)


def _relative(requested: KeySpec) -> KeySpec:
    if requested.mode == "major":
        return KeySpec((requested.tonic_pc + RELATIVE_MAJOR_TO_MINOR) % 12, "minor")
    return KeySpec((requested.tonic_pc + RELATIVE_MINOR_TO_MAJOR) % 12, "major")


def _signed_semitone_distance(detected: int, requested: int) -> int:
    """``requested - detected`` wrapped into -6..5 semitones."""
    return (requested - detected + 6) % 12 - 6


def check(audio: Audio, req: GateRequest, cfg: GateConfig) -> KeyResult:
    """Estimates the key, repairs a one-semitone error, or rejects."""
    detected, confidence = detect(audio)
    same = detected.tonic_pc == req.key.tonic_pc and detected.mode == req.key.mode
    relative = cfg.allow_relative_key and detected == _relative(req.key)
    shift = 0
    relation: Literal["same", "relative", "shifted", "off"]
    if same:
        relation = "same"
    elif relative:
        relation = "relative"
    else:
        distance = _signed_semitone_distance(detected.tonic_pc, req.key.tonic_pc)
        if detected.mode == req.key.mode and abs(distance) <= cfg.max_key_shift_semitones:
            relation, shift = "shifted", distance
        else:
            relation = "off"

    match = KeyMatch(
        detected=detected, confidence=confidence, relation=relation, shift_semitones=shift
    )
    metrics: dict[str, MetricValue] = {
        "detected_key": detected.label,
        "requested_key": req.key.label,
        "confidence": round(confidence, 4),
        "relation": relation,
        "shift_semitones": shift,
    }
    if relation == "off":
        return KeyResult(StepVerdict("key", False, metrics, "off-key"), audio, match)
    if shift == 0:
        return KeyResult(StepVerdict("key", True, metrics), audio, match)

    shifted = pitch_shift(audio.samples, float(shift), audio.sample_rate)
    corrected = Audio(np.ascontiguousarray(shifted, dtype=np.float32), audio.sample_rate)
    after, _ = detect(corrected)
    return KeyResult(
        StepVerdict("key", True, metrics | {"key_after_shift": after.label}), corrected, match
    )
