"""Synthetic rhythm fixtures with known ground truth.

These prove the *harness*, not the model: a click track has exact beat times, so
a metric computed against it can be checked by hand. They are generated on the
fly, hence nothing is checked in and no copyrighted audio is involved (13 §1.7).
Numbers measured on them are never reported as the eval gate.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

type F32 = NDArray[np.float32]
type F64 = NDArray[np.float64]


@dataclass(frozen=True)
class SyntheticTrack:
    """Audio plus its exact beats and downbeats."""

    name: str
    audio: F32
    sample_rate: int
    beats: F64
    downbeats: F64


def _burst(length: int, hz: float, sample_rate: int, decay: float) -> F32:
    t = np.arange(length) / sample_rate
    return (np.sin(2 * np.pi * hz * t) * np.exp(-t / decay)).astype(np.float32)


def click_track(
    bpm: float,
    seconds: float,
    *,
    sample_rate: int = 22_050,
    beats_per_bar: int = 4,
    first_beat_sec: float = 0.5,
    drift_per_beat: float = 0.0,
    noise_db: float | None = None,
    name: str | None = None,
) -> SyntheticTrack:
    """A kick-and-hat click track.

    Beat ``k`` sits at ``first_beat_sec + sum(period_i)``, where the period
    shrinks by ``drift_per_beat`` seconds per beat (a tempo ramp when non-zero).
    Downbeats are a low, loud kick; other beats a short hat, plus an off-beat hat so the
    tracker must pick the beat level out of a denser rhythm.
    """
    rng = np.random.default_rng(int(bpm * 100) + beats_per_bar)
    total = round(seconds * sample_rate)
    audio = np.zeros(total, dtype=np.float32)
    kick = _burst(int(0.12 * sample_rate), 60.0, sample_rate, 0.04)
    attack = int(0.004 * sample_rate)  # the beater click that gives a kick its onset
    kick[:attack] += rng.uniform(-0.6, 0.6, attack).astype(np.float32)
    hat = (
        rng.uniform(-1, 1, int(0.03 * sample_rate))
        * np.exp(-np.arange(int(0.03 * sample_rate)) / (0.006 * sample_rate))
    ).astype(np.float32)

    period = 60.0 / bpm
    beats: list[float] = []
    t = first_beat_sec
    k = 0
    while t < seconds - 0.2:
        beats.append(t)
        start = round(t * sample_rate)
        sound = kick * (1.0 if k % beats_per_bar == 0 else 0.6)
        audio[start : start + sound.size] += sound[: total - start]
        off = round((t + period / 2) * sample_rate)
        if off + hat.size < total:
            audio[off : off + hat.size] += 0.08 * hat
        t += max(period - drift_per_beat * k, 0.2)
        k += 1
    if noise_db is not None:
        audio += (10 ** (noise_db / 20) * rng.normal(0, 1, total)).astype(np.float32)
    audio = audio / max(float(np.max(np.abs(audio))), 1e-6) * 0.8
    beat_array = np.asarray(beats)
    return SyntheticTrack(
        name=name or f"click_{bpm:g}bpm_{beats_per_bar}-4",
        audio=audio,
        sample_rate=sample_rate,
        beats=beat_array,
        downbeats=beat_array[::beats_per_bar],
    )


def suite() -> list[SyntheticTrack]:
    """The standard synthetic suite: slow, mid and fast, a waltz, noisy, and a tempo ramp."""
    return [
        click_track(75, 40),
        click_track(100, 40),
        click_track(120, 40),
        click_track(128, 40, noise_db=-30, name="click_128bpm_4-4_noisy"),
        click_track(140, 40),
        click_track(96, 40, beats_per_bar=3),
        click_track(110, 40, drift_per_beat=0.0008, name="click_110bpm_ramp"),
    ]
