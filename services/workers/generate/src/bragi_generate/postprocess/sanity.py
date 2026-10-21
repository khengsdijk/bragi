"""Step 1 of 09 §6: silence, clipping and non-finite samples.

A candidate that is mostly silence, distorted into the rails or contains NaNs is
not worth warping or matching. This is the cheapest gate and runs first, so a
broken backend response never reaches the DSP.
"""

from __future__ import annotations

import numpy as np

from bragi_generate.postprocess.config import GateConfig
from bragi_generate.postprocess.types import Audio, StepVerdict


def check(audio: Audio, cfg: GateConfig) -> StepVerdict:
    """Measures the sanity metrics and rejects the candidate if any of them fails."""
    samples = audio.samples
    nonfinite = int(np.count_nonzero(~np.isfinite(samples)))
    peak = float(np.max(np.abs(samples))) if samples.size else 0.0
    clipped = float(np.mean(np.abs(samples) >= cfg.clip_level)) if samples.size else 1.0

    mono = audio.mono
    hop = max(1, round(cfg.silence_frame_sec * audio.sample_rate))
    count = mono.shape[0] // hop
    if count == 0:
        silent = 1.0
    else:
        power = np.asarray(mono[: count * hop], dtype=np.float64).reshape(count, hop) ** 2
        rms = np.sqrt(power.mean(axis=1))
        with np.errstate(divide="ignore"):
            dbfs = 20.0 * np.log10(np.maximum(rms, 1e-9))
        silent = float(np.mean(dbfs < cfg.silence_dbfs))

    metrics = {
        "nonfinite_samples": nonfinite,
        "silent_fraction": silent,
        "clipped_fraction": clipped,
        "peak": peak,
    }
    if nonfinite:
        return StepVerdict("sanity", False, metrics, "non-finite samples")
    if silent > cfg.silence_fraction:
        return StepVerdict("sanity", False, metrics, "silent")
    if clipped > cfg.clip_fraction:
        return StepVerdict("sanity", False, metrics, "clipped")
    return StepVerdict("sanity", True, metrics)
