"""Step 5 and 7 of 09 §6: splice search, seam score and equal-power crossfade.

``seam_score(render, seamPos)`` is the objective of 03 §8.2: three jumps across
a seam, each weighted (``config/generation_gates.toml``) and summed, lower is
better.

- **spectral-flux jump** — the analysis worker's log-compressed onset strength
  mean on each side; a seam that cuts a transient shows up as a step.
- **loudness jump** — the K-weighted level difference in LU across the seam.
- **onset-regularity change** — the relative change of onset density, catching a
  seam that drops or doubles hits without changing the average level.

The splice search evaluates every beat position inside the overlap (the
candidate's first ``overlap_bars`` bars) on the same local render it will later
produce, so the score it minimises is the score step 7 reports.

The crossfade is equal-power (``cos``/``sin`` of a quarter turn, so the gains
square to one) with a ±10 ms phase-aware offset chosen by cross-correlation: the
offset with the largest positive correlation cancels least.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray
from scipy import signal

from bragi_analysis.dsp.features import onset_strength, stft_magnitude
from bragi_generate.postprocess import match, onsets
from bragi_generate.postprocess.config import GateConfig
from bragi_generate.postprocess.types import Audio, GateRequest, StepVerdict

type F32 = NDArray[np.float32]
type F64 = NDArray[np.float64]

#: A seam window shorter than this is not scored (the metrics degenerate).
MIN_WINDOW_SEC = 0.05


@dataclass(frozen=True)
class SeamScore:
    """The three jumps and their weighted sum."""

    total: float
    flux_jump: float
    loudness_jump: float
    onset_change: float

    def metrics(self) -> dict[str, float]:
        """Flat metrics for a verdict."""
        return {
            "seam_score": round(self.total, 4),
            "flux_jump": round(self.flux_jump, 4),
            "loudness_jump_lu": round(self.loudness_jump, 4),
            "onset_change": round(self.onset_change, 4),
        }


@dataclass(frozen=True)
class SpliceResult:
    """The best position, its score and every evaluated position."""

    position: int
    score: float
    fade: int
    positions: tuple[int, ...]
    scores: tuple[float, ...]


@dataclass(frozen=True)
class SpliceSearch:
    """Step 5's verdict plus what the caller needs to build the splice."""

    verdict: StepVerdict
    result: SpliceResult | None
    detail: SeamScore | None


def crossfade_shape(length: int) -> tuple[F32, F32]:
    """Equal-power fade-out and fade-in gains of ``length`` samples."""
    theta = (np.arange(length, dtype=np.float64) + 0.5) / max(length, 1) * (np.pi / 2.0)
    return np.cos(theta).astype(np.float32), np.sin(theta).astype(np.float32)


def crossfade(before: F32, after: F32, length: int) -> F32:
    """Equal-power mix of ``before``'s last ``length`` samples with ``after``'s first."""
    count = min(length, before.shape[0], after.shape[0])
    fade_out, fade_in = crossfade_shape(count)
    mixed = before[-count:] * fade_out[:, None] + after[:count] * fade_in[:, None]
    return np.ascontiguousarray(mixed, dtype=np.float32)


def phase_offset(before: F32, search: F32, length: int, max_shift: int) -> int:
    """The shift in ±``max_shift`` samples that maximises the correlation.

    ``search`` must start ``max_shift`` samples before the unshifted position, so
    index y in the result means "move the after-audio y samples later".
    """
    if max_shift <= 0 or length <= 0 or search.shape[0] < length + 2 * max_shift:
        return 0
    reference = before[:length].mean(axis=1)
    region = search[: length + 2 * max_shift].mean(axis=1)
    if float(np.linalg.norm(reference)) < 1e-9 or float(np.linalg.norm(region)) < 1e-9:
        return 0
    scores = np.correlate(region, reference, mode="valid")
    return int(np.argmax(scores)) - max_shift


def seam_score(render: F32, seam_pos: int, sample_rate: int, cfg: GateConfig) -> SeamScore:
    """The weighted sum of the three jumps across ``seam_pos`` (lower is better)."""
    window = max(1, round(cfg.seam_window_sec * sample_rate))
    if seam_pos < window or render.shape[0] < seam_pos + window:
        return SeamScore(float("inf"), float("inf"), float("inf"), float("inf"))

    mono = np.ascontiguousarray(render.mean(axis=1), dtype=np.float32)
    magnitude = stft_magnitude(mono, onsets.N_FFT, onsets.HOP)
    flux = np.asarray(onset_strength(magnitude), dtype=np.float64)
    fps = sample_rate / onsets.HOP
    times = np.arange(flux.shape[0], dtype=np.float64) / fps
    seam_sec = seam_pos / sample_rate
    before_mask = (times >= seam_sec - cfg.seam_window_sec) & (times < seam_sec)
    after_mask = (times >= seam_sec) & (times < seam_sec + cfg.seam_window_sec)
    if not np.any(before_mask) or not np.any(after_mask):
        return SeamScore(float("inf"), float("inf"), float("inf"), float("inf"))

    before_flux = float(flux[before_mask].mean())
    after_flux = float(flux[after_mask].mean())
    flux_jump = abs(after_flux - before_flux) / (before_flux + after_flux + 1e-9)

    power = match.weighted_power(render, sample_rate)
    loudness_jump = abs(
        match.lufs(power, seam_pos, seam_pos + window)
        - match.lufs(power, seam_pos - window, seam_pos)
    )

    # Onsets are counted over two windows: one window of a beat-long groove holds
    # zero or one hit, which makes the density jump between 0 and 1 on its own.
    wide = 2.0 * cfg.seam_window_sec
    before_onsets = _onset_density(flux, times, seam_sec - wide, seam_sec, fps)
    after_onsets = _onset_density(flux, times, seam_sec, seam_sec + wide, fps)
    onset_change = abs(after_onsets - before_onsets) / (after_onsets + before_onsets + 1e-9)

    total = (
        cfg.seam_flux_weight * flux_jump
        + cfg.seam_loudness_weight * loudness_jump
        + cfg.seam_onset_weight * onset_change
    )
    return SeamScore(float(total), flux_jump, loudness_jump, onset_change)


def _onset_density(flux: F64, times: F64, start_sec: float, end_sec: float, fps: float) -> float:
    """Onsets per second inside a time span of the envelope."""
    mask = (times >= start_sec) & (times < end_sec)
    values = flux[mask]
    if values.size < 3 or float(np.std(values)) < 1e-9:
        return 0.0
    peaks, _ = signal.find_peaks(values, height=float(np.mean(values) + 0.5 * np.std(values)))
    return float(peaks.size) * fps / values.size


def render_splice(
    context_tail: F32,
    candidate: F32,
    context_start: int,
    candidate_start: int,
    fade: int,
    window: int,
) -> tuple[F32, int] | None:
    """The local render the seam score sees: pre-roll, crossfade, post-roll.

    ``context_tail`` is the overlap at the end of the context and the fade starts
    at ``context_start`` in it; the candidate side starts at ``candidate_start``.
    The returned seam position is the first sample of the fade. ``None`` when
    there is not enough audio either side.
    """
    if context_start < window or context_tail.shape[0] < context_start + fade:
        return None
    if candidate.shape[0] < candidate_start + fade + window:
        return None
    pre = context_tail[context_start - window : context_start]
    mixed = crossfade(
        context_tail[context_start : context_start + fade],
        candidate[candidate_start:],
        fade,
    )
    post = candidate[candidate_start + fade : candidate_start + fade + window]
    render = np.concatenate([pre, mixed, post], axis=0)
    return np.ascontiguousarray(render, dtype=np.float32), pre.shape[0]


def _positions(
    beats: NDArray[np.int64], req: GateRequest, candidate: Audio, grid_fallback: bool
) -> NDArray[np.int64]:
    """The tracked beats, plus the requested grid anchored on the first of them."""
    if not grid_fallback or beats.size == 0:
        return beats
    step = max(1, round(req.beat_sec * candidate.sample_rate))
    first = int(beats[0])
    last = int(beats[-1])
    grid = np.arange(first, last + step + 1, step, dtype=np.int64)
    return np.unique(np.concatenate([beats, grid]))


def splice_search(
    context: Audio,
    candidate: Audio,
    beat_samples: NDArray[np.int64],
    req: GateRequest,
    cfg: GateConfig,
    *,
    grid_fallback: bool = False,
) -> SpliceSearch:
    """Evaluates every beat position inside the overlap and picks the best one.

    ``grid_fallback`` adds the requested tempo's beat grid (anchored on the first
    tracked beat) to the tracked positions. A two-bar overlap always holds enough
    tracked beats; a one-bar one can hold none when the tracker locked to half time,
    which would reject a good candidate for lack of a position rather than a seam.
    """
    overlap = min(round(req.overlap_sec * candidate.sample_rate), context.frames)
    window = max(1, round(cfg.seam_window_sec * candidate.sample_rate))
    minimum = max(1, round(MIN_WINDOW_SEC * candidate.sample_rate))
    if overlap <= window + minimum:
        return SpliceSearch(StepVerdict("splice", False, {}, "overlap too short"), None, None)

    fade = max(
        1,
        round(
            min(cfg.crossfade_beats * req.beat_sec, cfg.crossfade_max_sec) * candidate.sample_rate
        ),
    )
    context_tail = np.ascontiguousarray(context.samples[-overlap:], dtype=np.float32)
    positions = sorted(
        {
            int(position)
            for position in _positions(beat_samples, req, candidate, grid_fallback)
            if window <= int(position) <= overlap - fade
        }
    )
    scored: list[int] = []
    scores: list[float] = []
    details: list[SeamScore] = []
    for position in positions:
        rendered = render_splice(context_tail, candidate.samples, position, position, fade, window)
        if rendered is None:
            continue
        detail = seam_score(rendered[0], rendered[1], candidate.sample_rate, cfg)
        scored.append(position)
        scores.append(detail.total)
        details.append(detail)
    if not scores:
        return SpliceSearch(
            StepVerdict("splice", False, {"candidates": 0}, "no splice position"), None, None
        )

    best = int(np.argmin(np.asarray(scores)))
    detail = details[best]
    result = SpliceResult(
        position=scored[best],
        score=scores[best],
        fade=fade,
        positions=tuple(scored),
        scores=tuple(scores),
    )
    metrics = detail.metrics() | {"position": scored[best], "candidates": len(scored)}
    if scores[best] > cfg.seam_max_score:
        return SpliceSearch(
            StepVerdict("splice", False, metrics, "no splice point below the seam threshold"),
            result,
            detail,
        )
    return SpliceSearch(StepVerdict("splice", True, metrics), result, detail)
