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

from dataclasses import dataclass
from functools import lru_cache

import numpy as np
from numpy.typing import NDArray

from bragi_generate.postprocess import alignment, match, sanity, seam, tempo, tonality
from bragi_generate.postprocess.config import GateConfig
from bragi_generate.postprocess.types import (
    Audio,
    FillGateRequest,
    FillGateResult,
    GateRequest,
    GateResult,
    KeyMatch,
    MetricValue,
    StepVerdict,
)

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


def postprocess_fill(
    candidate: Audio,
    before: Audio,
    after: Audio,
    req: FillGateRequest,
    cfg: GateConfig | None = None,
) -> FillGateResult:
    """Runs the gates at both seams of a two-sided candidate (09 §4.3-4.4, §6).

    Steps 1-4 run once against the left context (the candidate's head re-creates
    its tail). Step 5 runs twice: forward at the start seam, and at the end seam
    with the roles swapped — the candidate's tail is the context and ``after`` is
    the continuation, which is the same musical comparison as a backward extend
    mirrored. Step 6 matches the head to ``before`` and the tail to ``after``
    (WP-2.7's loudness fix), and step 7 scores both seams.

    ``candidate`` is the backend's full ``overlap + middle + overlap`` span. For a
    transition the after context is shifted by the lead: the span replaces the
    last ``lead`` bars of ``before`` and the first ``lead`` bars of ``after``.
    """
    config = cfg if cfg is not None else _default_config()
    return _fill(candidate, before, after, req, config)


@dataclass(frozen=True)
class _Stage:
    """Steps 1-4's outcome: the audio to splice and every verdict so far."""

    audio: Audio
    steps: tuple[StepVerdict, ...]
    key_match: KeyMatch | None
    tempo_error: float
    #: The candidate's beat positions in ``audio``; ``None`` after a short circuit.
    beats: NDArray[np.int64] | None


def _stage(candidate: Audio, context: Audio, req: GateRequest, cfg: GateConfig) -> _Stage:
    """Runs sanity, tempo conform, key check and beat align (09 §6 steps 1-4)."""
    steps: list[StepVerdict] = []

    sanity_verdict = sanity.check(candidate, cfg)
    steps.append(sanity_verdict)
    if not sanity_verdict.passed:
        return _Stage(candidate, tuple(steps), None, 1.0, None)

    tempo_result = tempo.conform(candidate, req, cfg)
    steps.append(tempo_result.verdict)
    if not tempo_result.verdict.passed:
        return _Stage(
            tempo_result.audio, tuple(steps), None, _tempo_error(tempo_result.verdict), None
        )

    key_result = tonality.check(tempo_result.audio, req, cfg)
    steps.append(key_result.verdict)
    if not key_result.verdict.passed:
        return _Stage(
            key_result.audio,
            tuple(steps),
            key_result.match,
            _tempo_error(tempo_result.verdict),
            None,
        )

    aligned = alignment.beat_align(key_result.audio, context, req, cfg)
    steps.append(aligned.verdict)
    if not aligned.verdict.passed:
        return _Stage(
            aligned.audio,
            tuple(steps),
            key_result.match,
            _tempo_error(tempo_result.verdict),
            None,
        )

    rate = aligned.audio.sample_rate
    beats = np.rint(tempo_result.beats_sec * rate).astype(np.int64) - aligned.shift_samples
    return _Stage(
        aligned.audio, tuple(steps), key_result.match, _tempo_error(tempo_result.verdict), beats
    )


def _forward(candidate: Audio, context: Audio, req: GateRequest, cfg: GateConfig) -> GateResult:
    stage = _stage(candidate, context, req, cfg)
    steps = list(stage.steps)
    if stage.beats is None:
        return _rejected(stage.audio, steps, req, key_match=stage.key_match)

    rate = stage.audio.sample_rate
    search = seam.splice_search(context, stage.audio, stage.beats, req, cfg)
    steps.append(search.verdict)
    result = search.result
    if result is None:
        return _rejected(stage.audio, steps, req, key_match=stage.key_match)

    start = result.position
    max_shift = max(1, round(cfg.crossfade_phase_search_sec * rate))
    overlap = min(round(req.overlap_sec * rate), context.frames)
    context_tail = np.ascontiguousarray(context.samples[-overlap:], dtype=np.float32)
    shift = seam.phase_offset(
        context_tail[start : start + result.fade],
        stage.audio.samples[start - max_shift : start + result.fade + max_shift],
        result.fade,
        max_shift,
    )
    if start + shift < round(cfg.seam_window_sec * rate):
        shift = 0
    start += shift

    trim = np.ascontiguousarray(stage.audio.samples[start:], dtype=np.float32)
    if trim.shape[0] <= result.fade:
        return _rejected(stage.audio, steps, req, key_match=stage.key_match)
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
        tempo_error=stage.tempo_error,
        key_match=stage.key_match,
        match_eq=eq,
        splice_offset_samples=start - overlap,
        direction=req.direction,
    )


def _fill(
    candidate: Audio, before: Audio, after: Audio, req: FillGateRequest, cfg: GateConfig
) -> FillGateResult:
    """Runs the two-sided gates; see :func:`postprocess_fill`."""
    if candidate.sample_rate != before.sample_rate or before.sample_rate != after.sample_rate:
        raise ValueError("the candidate and both contexts must share a sample rate")
    if before.frames == 0 or after.frames == 0:
        raise ValueError("both contexts must have audio")

    grid = req.grid
    rate = candidate.sample_rate
    lead = round(req.lead_sec * rate)
    overlap = min(round(req.overlap_sec * rate), candidate.frames)
    window = max(1, round(cfg.seam_window_sec * rate))
    if before.frames < lead + overlap or after.frames < lead + overlap:
        raise ValueError("each context must be longer than the lead plus the overlap")

    # The left side ends where the generated span starts; the right side starts
    # where it ends. For an inpaint both are the contexts themselves; for a
    # transition the lead bars on each side are the audio the bridge replaces.
    before_ctx = before.trimmed(0, before.frames - lead)
    after_ctx = after.trimmed(lead)
    if before_ctx.frames < overlap + window or after_ctx.frames < overlap + window:
        raise ValueError("each context must hold the overlap plus one seam window")

    stage = _stage(candidate, before_ctx, grid, cfg)
    steps = list(stage.steps)
    if stage.beats is None:
        return _rejected_fill(stage.audio, steps, req, key_match=stage.key_match)

    # Start seam: exactly extend's forward search (09 §6 step 5), with the requested
    # grid added because a one-bar overlap can hold no tracked beat at half time.
    start_search = seam.splice_search(
        before_ctx, stage.audio, stage.beats, grid, cfg, grid_fallback=True
    )
    start_result = start_search.result
    if start_result is None:
        steps.append(start_search.verdict)
        return _rejected_fill(stage.audio, steps, req, key_match=stage.key_match)

    # End seam: the candidate's tail is the context and ``after`` continues it, so
    # the same search measures the splice in playback order. Its positions are the
    # candidate's own beats inside the tail overlap.
    tail = min(round(req.overlap_sec * rate), stage.audio.frames)
    tail_beats = np.asarray(
        [int(beat) - (stage.audio.frames - tail) for beat in stage.beats],
        dtype=np.int64,
    )
    tail_beats = tail_beats[tail_beats >= 0]
    end_search = seam.splice_search(
        stage.audio, after_ctx, tail_beats, grid, cfg, grid_fallback=True
    )
    end_result = end_search.result
    steps.append(_splice_verdict(start_search.verdict, end_search.verdict))
    if end_result is None:
        return _rejected_fill(stage.audio, steps, req, key_match=stage.key_match)

    start = start_result.position
    max_shift = max(1, round(cfg.crossfade_phase_search_sec * rate))
    before_tail = np.ascontiguousarray(before_ctx.samples[-overlap:], dtype=np.float32)
    shift = seam.phase_offset(
        before_tail[start : start + start_result.fade],
        stage.audio.samples[start - max_shift : start + start_result.fade + max_shift],
        start_result.fade,
        max_shift,
    )
    if start + shift < window:
        shift = 0
    start += shift

    # The processed span runs from the start splice to the end of the end-seam
    # crossfade, so its last ``fade`` samples are what the app fades into ``after``.
    # They are deliberately not faded here: the app's crossfade at the end seam is
    # the only fade, so the final score measures the same render as the search.
    fade = end_result.fade
    end = stage.audio.frames - tail + end_result.position + fade
    if end - start <= 2 * fade:
        return _rejected_fill(stage.audio, steps, req, key_match=stage.key_match)
    trim = np.ascontiguousarray(stage.audio.samples[start:end], dtype=np.float32)
    trimmed = Audio(trim, rate)
    gain = match.loudness_match(trimmed, before_ctx, cfg, after=after_ctx)
    eq = match.spectral_match(gain.audio, before_ctx, cfg)
    matched = gain.audio

    # Both seams are scored on the unfaded span, which is the render the app's own
    # crossfades produce; the head fade below is only a safety fade for auditioning
    # the clip on its own and is not part of the score.
    start_score = _final_score(before_tail, matched, start, start_result.fade, cfg)
    end_score = _end_final_score(matched, after_ctx, end_result.position, fade, cfg)
    processed = np.ascontiguousarray(matched.samples, dtype=np.float32)
    fade_in, _ = seam.crossfade_shape(fade)
    processed[:fade] *= fade_in[:, None]
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
    steps.append(
        StepVerdict(
            "final_seam",
            True,
            {
                "seam_score": round(start_score, 4),
                "end_seam_score": round(end_score, 4),
            },
        )
    )

    passed = all(verdict.passed for verdict in steps)
    return FillGateResult(
        processed=Audio(processed, rate),
        passed=passed,
        steps=tuple(steps),
        quality_warning=not passed,
        seam_score=start_score,
        end_seam_score=end_score,
        tempo_error=stage.tempo_error,
        key_match=stage.key_match,
        match_eq=eq,
        start_offset_samples=start - lead - overlap,
        end_offset_samples=lead + end_result.position + fade,
    )


def _splice_verdict(start: StepVerdict, end: StepVerdict) -> StepVerdict:
    """One ``splice`` step covering both searches; the end's metrics are prefixed."""
    metrics: dict[str, MetricValue] = dict(start.metrics)
    for name, value in end.metrics.items():
        metrics[f"end_{name}"] = value
    if start.passed and end.passed:
        return StepVerdict("splice", True, metrics)
    reason = start.reason if not start.passed else f"end seam: {end.reason or 'failed'}"
    return StepVerdict("splice", False, metrics, reason)


def _end_final_score(
    processed: Audio, after: Audio, start: int, fade: int, cfg: GateConfig
) -> float:
    """The final seam score at the end splice, from the app's handover to ``after``.

    ``start`` is the splice position inside the after overlap and ``fade`` the
    crossfade length; ``processed``'s last ``fade`` samples are the candidate's
    side of that crossfade.
    """
    window = max(1, round(cfg.seam_window_sec * processed.sample_rate))
    if processed.frames < window + fade or after.frames < start + fade + window:
        return float("inf")
    pre = processed.samples[-(window + fade) : -fade]
    mixed = seam.crossfade(processed.samples[-fade:], after.samples[start:], fade)
    post = after.samples[start + fade : start + fade + window]
    render = np.concatenate([pre, mixed, post], axis=0)
    detail = seam.seam_score(
        np.ascontiguousarray(render, dtype=np.float32),
        window,
        processed.sample_rate,
        cfg,
    )
    return detail.total


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


def _rejected_fill(
    audio: Audio,
    steps: list[StepVerdict],
    req: FillGateRequest,
    *,
    key_match: KeyMatch | None = None,
) -> FillGateResult:
    """A failed two-sided candidate: the audio so far and the skipped later steps."""
    passed = all(verdict.passed for verdict in steps)
    completed = {verdict.step for verdict in steps}
    for name in STEP_NAMES:
        if name not in completed:
            steps.append(StepVerdict(name, False, {}, "skipped", skipped=True))
    tempo_error = 1.0
    for verdict in steps:
        if verdict.step == "tempo":
            tempo_error = _tempo_error(verdict)
    return FillGateResult(
        processed=audio,
        passed=passed,
        steps=tuple(steps),
        quality_warning=not passed,
        seam_score=float("inf"),
        end_seam_score=float("inf"),
        tempo_error=tempo_error,
        key_match=key_match,
        match_eq=None,
        start_offset_samples=0,
        end_offset_samples=0,
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
