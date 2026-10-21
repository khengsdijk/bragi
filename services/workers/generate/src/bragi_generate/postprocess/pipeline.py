"""The quality gates of 09 §6, in order, behind one entry point.

``postprocess(candidate, context, req, cfg)`` runs sanity → tempo conform → key
check → beat align → splice search + crossfade → loudness/spectral match →
final seam score and returns both the processed audio and every verdict.

Short-circuiting matches the spec: a candidate that fails sanity, tempo, key or
alignment is not worth splicing. The splice gate is different — a candidate that
fails it is still trimmed, matched and scored, because 09 §6 asks the worker to
return the best candidate with ``qualityWarning`` when none pass, and the user
should still be able to hear it.

The backward direction (intros, 09 §4.2 step 5) is the forward pipeline on both
signals played backwards: every step is symmetric, so mirroring avoids a second
implementation. ``splice_offset_samples`` is then relative to the context start.
"""

from __future__ import annotations

from functools import lru_cache

import numpy as np

from bragi_generate.postprocess import alignment, match, sanity, seam, tempo, tonality
from bragi_generate.postprocess.config import GateConfig
from bragi_generate.postprocess.types import Audio, GateRequest, GateResult, KeyMatch, StepVerdict

#: Steps after a short-circuit, in 09 §6 order; reported as skipped.
STEP_NAMES: tuple[str, ...] = (
    "sanity",
    "tempo",
    "key",
    "beat_align",
    "splice",
    "match",
    "final_seam",
)


@lru_cache(maxsize=1)
def _default_config() -> GateConfig:
    return GateConfig.load()


def postprocess(
    candidate: Audio,
    context: Audio,
    req: GateRequest,
    cfg: GateConfig | None = None,
) -> GateResult:
    """Runs every gate over one candidate against its context."""
    config = cfg if cfg is not None else _default_config()
    if candidate.sample_rate != context.sample_rate:
        raise ValueError(
            f"candidate is {candidate.sample_rate} Hz but the context is {context.sample_rate} Hz"
        )
    if context.frames == 0:
        raise ValueError("the context is empty")

    if req.direction == "backward":
        mirrored = _forward(candidate.reversed(), context.reversed(), req, config)
        return _mirror(mirrored)
    return _forward(candidate, context, req, config)


def _forward(candidate: Audio, context: Audio, req: GateRequest, cfg: GateConfig) -> GateResult:
    steps: list[StepVerdict] = []

    sanity_verdict = sanity.check(candidate, cfg)
    steps.append(sanity_verdict)
    if not sanity_verdict.passed:
        return _rejected(candidate, steps, req)

    tempo_result = tempo.conform(candidate, req, cfg)
    steps.append(tempo_result.verdict)
    if not tempo_result.verdict.passed:
        return _rejected(tempo_result.audio, steps, req)

    key_result = tonality.check(tempo_result.audio, req, cfg)
    steps.append(key_result.verdict)
    if not key_result.verdict.passed:
        return _rejected(key_result.audio, steps, req, key_match=key_result.match)

    aligned = alignment.beat_align(key_result.audio, context, req, cfg)
    steps.append(aligned.verdict)
    if not aligned.verdict.passed:
        return _rejected(aligned.audio, steps, req, key_match=key_result.match)

    rate = aligned.audio.sample_rate
    beats = np.rint(tempo_result.beats_sec * rate).astype(np.int64) - aligned.shift_samples
    search = seam.splice_search(context, aligned.audio, beats, req, cfg)
    steps.append(search.verdict)
    result = search.result
    if result is None:
        return _rejected(aligned.audio, steps, req, key_match=key_result.match)

    start = result.position
    max_shift = max(1, round(cfg.crossfade_phase_search_sec * rate))
    overlap = min(round(req.overlap_sec * rate), context.frames)
    context_tail = np.ascontiguousarray(context.samples[-overlap:], dtype=np.float32)
    shift = seam.phase_offset(
        context_tail[start : start + result.fade],
        aligned.audio.samples[start - max_shift : start + result.fade + max_shift],
        result.fade,
        max_shift,
    )
    if start + shift < round(cfg.seam_window_sec * rate):
        shift = 0
    start += shift

    trim = np.ascontiguousarray(aligned.audio.samples[start:], dtype=np.float32)
    if trim.shape[0] <= result.fade:
        return _rejected(aligned.audio, steps, req, key_match=key_result.match)
    _, fade_in = seam.crossfade_shape(result.fade)
    trim[: result.fade] *= fade_in[:, None]

    trimmed = Audio(trim, rate)
    gain = match.loudness_match(trimmed, context, cfg)
    eq = match.spectral_match(gain.audio, context, cfg)
    matched = gain.audio

    final_score = _final_score(context_tail, matched, start, result.fade, cfg)
    steps.append(
        StepVerdict(
            "match",
            True,
            {
                "target_lufs": round(gain.target_lufs, 3),
                "head_gain_db": round(gain.head_gain_db, 3),
                "tail_gain_db": round(gain.tail_gain_db, 3),
                "eq_max_abs_db": round(max(abs(band) for band in eq.bands), 3),
            },
        )
    )
    steps.append(StepVerdict("final_seam", True, {"seam_score": round(final_score, 4)}))

    passed = all(verdict.passed for verdict in steps)
    return GateResult(
        processed=matched,
        passed=passed,
        steps=tuple(steps),
        quality_warning=not passed,
        seam_score=final_score,
        tempo_error=_tempo_error(tempo_result.verdict),
        key_match=key_result.match,
        match_eq=eq,
        splice_offset_samples=start - overlap,
        direction=req.direction,
    )


def _final_score(
    context_tail: np.ndarray, processed: Audio, start: int, fade: int, cfg: GateConfig
) -> float:
    window = max(1, round(cfg.seam_window_sec * processed.sample_rate))
    rendered = seam.render_splice(context_tail, processed.samples, start, 0, fade, window)
    if rendered is None:
        return float("inf")
    detail = seam.seam_score(rendered[0], rendered[1], processed.sample_rate, cfg)
    return detail.total


def _tempo_error(verdict: StepVerdict) -> float:
    value = verdict.metrics.get("tempo_error", 1.0)
    return float(value) if isinstance(value, int | float) else 1.0


def _rejected(
    audio: Audio,
    steps: list[StepVerdict],
    req: GateRequest,
    *,
    key_match: KeyMatch | None = None,
) -> GateResult:
    """A failed candidate: the audio as processed so far and skipped later steps."""
    passed = all(verdict.passed for verdict in steps)
    completed = {verdict.step for verdict in steps}
    for name in STEP_NAMES:
        if name not in completed:
            steps.append(StepVerdict(name, False, {}, "skipped", skipped=True))
    return GateResult(
        processed=audio,
        passed=passed,
        steps=tuple(steps),
        quality_warning=not passed,
        seam_score=float("inf"),
        tempo_error=_tempo_error(next(v for v in steps if v.step == "tempo")),
        key_match=key_match,
        match_eq=None,
        splice_offset_samples=0,
        direction=req.direction,
    )


def _mirror(result: GateResult) -> GateResult:
    """Flips a forward result back into playback order (for the backward direction)."""
    return GateResult(
        processed=result.processed.reversed(),
        passed=result.passed,
        steps=result.steps,
        quality_warning=result.quality_warning,
        seam_score=result.seam_score,
        tempo_error=result.tempo_error,
        key_match=result.key_match,
        match_eq=result.match_eq,
        splice_offset_samples=result.splice_offset_samples,
        direction="backward",
    )
