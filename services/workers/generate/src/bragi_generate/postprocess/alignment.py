"""Step 4 of 09 §6: beat-align the candidate against the context (03 §8.2).

The candidate's first two bars are the overlap the model wrote as a repeat of the
context's last two bars, so their onset envelopes are highly correlated when the
phase is right and clearly less when it is off. We cross-correlate the two
envelopes over ±1 beat (a whole beat, because a model can land on the off-beat)
and take the normalised peak as the confidence.

The winning lag is applied to the audio as a whole-sample shift: positive means
"the candidate is late, drop it from the head", negative means "it is early,
prepend silence". The audio after this shift starts where the context's tail
would have continued.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

from bragi_generate.postprocess import onsets
from bragi_generate.postprocess.config import GateConfig
from bragi_generate.postprocess.types import Audio, GateRequest, StepVerdict

type F32 = NDArray[np.float32]
type F64 = NDArray[np.float64]


@dataclass(frozen=True)
class AlignResult:
    """The verdict, the shifted audio and the shift in samples."""

    verdict: StepVerdict
    audio: Audio
    shift_samples: int
    confidence: float


def _normalise(values: F64) -> F64:
    """Zero-mean, unit-norm: a cosine that ignores the envelope's DC and level."""
    centred = values - float(values.mean())
    norm = float(np.linalg.norm(centred))
    return centred / norm if norm > 1e-9 else np.zeros_like(values)


def correlation(
    candidate: F32,
    context: F32,
    sample_rate: int,
    window_sec: float,
    max_lag_sec: float,
) -> tuple[int, float]:
    """Best lag in samples and the normalised peak in 0..1.

    A positive lag means the candidate must be moved earlier (it is late). Lags
    are searched in order of increasing magnitude, so a periodic pattern that
    correlates equally at ±1 beat keeps the smallest correction.
    """
    cand_env, fps = onsets.envelope(candidate, sample_rate, floored=False)
    ctx_env, _ = onsets.envelope(context, sample_rate, floored=False)
    window = max(3, round(window_sec * fps))
    max_lag = max(1, round(max_lag_sec * fps))
    if ctx_env.size < window or cand_env.size < window:
        return 0, 0.0

    reference = ctx_env[-window:]
    candidate_window = cand_env[:window]
    best_lag = 0
    best_score = -1.0
    for lag in sorted(range(-max_lag, max_lag + 1), key=abs):
        if lag >= 0:
            head, tail = reference[: window - lag], candidate_window[lag:]
        else:
            head, tail = reference[-lag:], candidate_window[: window + lag]
        score = float(np.dot(_normalise(head), _normalise(tail)))
        if score > best_score + 1e-9:
            best_lag, best_score = lag, score
    return round(best_lag * sample_rate / fps), max(0.0, min(1.0, best_score))


def beat_align(audio: Audio, context: Audio, req: GateRequest, cfg: GateConfig) -> AlignResult:
    """Cross-correlates the overlap and shifts the candidate to the best lag."""
    window_sec = cfg.align_bars * req.bar_sec
    shift, confidence = correlation(
        audio.mono,
        context.mono,
        audio.sample_rate,
        window_sec,
        cfg.align_search_beats * req.beat_sec,
    )
    shift_samples = shift
    shifted = _shift(audio.samples, shift_samples)
    metrics = {
        "confidence": round(confidence, 4),
        "shift_ms": round(1000.0 * shift_samples / audio.sample_rate, 3),
    }
    if confidence < cfg.align_min_confidence:
        return AlignResult(
            StepVerdict("beat_align", False, metrics, "alignment confidence below the gate"),
            audio,
            shift_samples,
            confidence,
        )
    return AlignResult(
        StepVerdict("beat_align", True, metrics),
        Audio(np.ascontiguousarray(shifted, dtype=np.float32), audio.sample_rate),
        shift_samples,
        confidence,
    )


def _shift(samples: F32, shift_samples: int) -> F32:
    """Moves audio in time by ``shift_samples`` (positive = earlier), zero-padded."""
    if shift_samples == 0:
        return samples
    if shift_samples > 0:
        if shift_samples >= samples.shape[0]:
            return np.zeros((0, samples.shape[1]), dtype=np.float32)
        return samples[shift_samples:]
    if -shift_samples >= samples.shape[0]:
        return np.zeros((0, samples.shape[1]), dtype=np.float32)
    keep = samples.shape[0] + shift_samples
    padded = np.zeros((samples.shape[0], samples.shape[1]), dtype=np.float32)
    padded[-shift_samples:] = samples[:keep]
    return padded
