"""Synthetic signals for the postprocess gate tests (13 §1.7: no audio files).

Every signal is generated from noise and sine partials at a known BPM and key,
so the ground truth is exact: a click track's beats are the sample indices the
generator used, and a chord pad's key is the pitch classes it was built from.
"""

from __future__ import annotations

import numpy as np
from numpy.typing import NDArray

from bragi_generate.postprocess.types import Audio, Direction, GateRequest, KeySpec, StepVerdict

SAMPLE_RATE = 48_000
#: Kick/hat decay used by the drum patterns, in seconds.
HIT_SEC = 0.08


def audio(samples: NDArray[np.floating], sample_rate: int = SAMPLE_RATE) -> Audio:
    """Mono or ``(frames, channels)`` input as float32 stereo :class:`Audio`."""
    values = np.asarray(samples, dtype=np.float32)
    if values.ndim == 1:
        values = np.stack([values, values], axis=1)
    return Audio(np.ascontiguousarray(values, dtype=np.float32), sample_rate)


def click_track(bpm: float, seconds: float, *, gain: float = 0.5) -> Audio:
    """A short noise burst on every beat, silent between."""
    rate = SAMPLE_RATE
    total = np.zeros(round(seconds * rate), dtype=np.float32)
    period = 60.0 / bpm
    rng = np.random.default_rng(7)
    hit = rng.standard_normal(round(0.004 * rate)).astype(np.float32)
    for index in range(int(seconds / period)):
        start = round(index * period * rate)
        total[start : start + hit.shape[0]] += gain * hit * np.hanning(hit.shape[0])
    return audio(total)


def drum_pattern(
    bpm: float,
    seconds: float,
    *,
    phase_sec: float = 0.0,
    seed: int = 11,
    gain: float = 0.5,
    bed: float = 0.012,
) -> Audio:
    """Kick on the beat, hat off the beat over a quiet tonal bed.

    The bed keeps the signal out of the "mostly silent" sanity gate without
    adding broadband flux: a noise bed would swamp the onset envelope, because
    the flux is summed over every bin.
    """
    rate = SAMPLE_RATE
    total = np.zeros(round(seconds * rate), dtype=np.float32)
    period = 60.0 / bpm
    rng = np.random.default_rng(seed)
    length = round(HIT_SEC * rate)
    envelope = np.exp(-np.linspace(0.0, 6.0, length)).astype(np.float32)
    kick = np.sin(2 * np.pi * 55.0 * np.arange(length) / rate).astype(np.float32)
    hat = rng.standard_normal(length).astype(np.float32)
    hats = np.stack([hat, np.roll(hat, 17)], axis=1) * 0.35
    beat = 0
    while True:
        start = round((beat * period + phase_sec) * rate)
        if start + length >= total.shape[0]:
            break
        burst = (kick * envelope * gain).astype(np.float32)
        total[start : start + length] += burst
        hat_start = round((beat * period + phase_sec + period / 2.0) * rate)
        if hat_start + length < total.shape[0]:
            total[hat_start : hat_start + length] += hats.mean(axis=1) * envelope * 0.6
        beat += 1
    time = np.arange(total.shape[0]) / rate
    bed_signal = np.stack(
        [np.sin(2 * np.pi * frequency * time) for frequency in (110.0, 165.0, 220.0)]
    ).mean(axis=0)
    return audio(total + (bed * bed_signal).astype(np.float32))


def chord_pad(
    root_pc: int,
    mode: str,
    seconds: float,
    *,
    gain: float = 0.25,
    transpose: int = 0,
    span_sec: float | None = None,
) -> Audio:
    """A looping I-IV-V-I pad in the given key, three partials per note.

    ``span_sec`` is the length of one chord; the default spreads the four chords
    over the whole signal. Passing a chord-length that divides ``seconds`` makes
    the pad periodic, which is what a continuous song needs.
    """
    rate = SAMPLE_RATE
    total = np.zeros(round(seconds * rate), dtype=np.float32)
    degrees = (0, 5, 7, 0)
    quality = (0, 4, 7) if mode == "major" else (0, 3, 7)
    span = span_sec if span_sec is not None else seconds / len(degrees)
    t = np.arange(total.shape[0]) / rate
    chord = 0
    while chord * span < seconds:
        start = round(chord * span * rate)
        end = min(round((chord + 1) * span * rate), total.shape[0])
        degree = degrees[chord % len(degrees)]
        local = t[start:end] - t[start]
        envelope = np.clip(np.minimum(local / 0.05, (span - local) / 0.05), 0.0, 1.0)
        for interval in quality:
            midi = 60 + (root_pc + transpose + degree + interval) % 12 + 12
            frequency = 440.0 * 2.0 ** ((midi - 69) / 12.0)
            wave = (
                np.sin(2 * np.pi * frequency * local)
                + 0.4 * np.sin(2 * np.pi * 2 * frequency * local)
                + 0.2 * np.sin(2 * np.pi * 3 * frequency * local)
            )
            total[start:end] += (gain / 3.0 * envelope * wave).astype(np.float32)
        chord += 1
    return audio(total)


def request(
    bpm: float = 120.0,
    *,
    tonic: str = "C",
    mode: str = "major",
    bars: int = 2,
    direction: Direction = "forward",
) -> GateRequest:
    """A 4/4 extend request with the default 2-bar overlap."""
    return GateRequest(
        bpm=bpm,
        time_signature=(4, 4),
        key=KeySpec.parse(tonic, mode),
        bars=bars,
        overlap_bars=2,
        direction=direction,
    )


def song(
    bpm: float,
    seconds: float,
    *,
    root_pc: int = 0,
    mode: str = "major",
    transpose: int = 0,
    seed: int = 11,
) -> Audio:
    """Drums plus a pad in a known key: enough material for every gate at once."""
    drums = drum_pattern(bpm, seconds, seed=seed)
    pad = chord_pad(root_pc, mode, seconds, transpose=transpose, span_sec=60.0 / bpm)
    return audio(np.clip(drums.samples + pad.samples, -1.0, 1.0))


def slice_audio(signal: Audio, start_sec: float, end_sec: float) -> Audio:
    """Samples ``[start_sec, end_sec)`` of an :class:`Audio`."""
    rate = signal.sample_rate
    return audio(signal.samples[round(start_sec * rate) : round(end_sec * rate)], rate)


def scale(signal: Audio, factor: float) -> Audio:
    """A copy at a different gain (for the loudness-jump candidate)."""
    return audio(signal.samples * factor, signal.sample_rate)


def noisy(signal: Audio, level: float, *, seed: int = 3) -> Audio:
    """Adds white noise, optionally a lot of it (for the unalignable candidate)."""
    rng = np.random.default_rng(seed)
    noise = rng.standard_normal(signal.samples.shape).astype(np.float32) * level
    return audio(signal.samples + noise, signal.sample_rate)


def clipped(signal: Audio) -> Audio:
    """Rails a candidate: > 0.1 % of samples at |x| >= 0.999."""
    return audio(np.clip(signal.samples * 60.0, -1.0, 1.0), signal.sample_rate)


def metric(verdict: StepVerdict, name: str) -> float:
    """A numeric gate metric, narrowed for the type checker."""
    value = verdict.metrics[name]
    assert isinstance(value, int | float)
    return float(value)
