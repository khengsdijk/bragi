"""A deterministic synthetic backend: drums, bass and a chord pad, no model.

It exists for the tests and the live e2e without ACE-Step (``BRAGI_GENERATION_BACKEND
=fake``). The output follows the requested BPM, meter and key, continues the
context's loudness, and keeps the pattern's phase across the seam, so the quality
gates of 09 §6 run against something musically coherent instead of a tone burst.

Everything is generated from the seed: the same seed gives bit-identical audio, and
a different seed only changes velocities, the progression rotation and a little pad
detune. No audio file is ever committed (13 §1.7).
"""

from __future__ import annotations

import time
from collections.abc import Callable

import numpy as np
from numpy.typing import NDArray

from bragi_generate.audio import rms, rms_db, scale
from bragi_generate.backend import GenOutput, GenRequest, GenTimings, Tier
from bragi_generate.postprocess.types import Audio, KeySpec

#: Semitone offsets of a four-bar progression, from the tonic.
_MINOR_PROGRESSION: tuple[int, ...] = (0, 8, 3, 10)  # i - VI - III - VII
_MAJOR_PROGRESSION: tuple[int, ...] = (0, 7, 9, 5)  # I - V - vi - IV
#: Pitch-class offsets of the triads that are minor in each mode.
_MINOR_TRIAD_OFFSETS: frozenset[int] = frozenset({0, 5, 7})  # i, iv, v in natural minor
_MAJOR_MINOR_TRIAD_OFFSETS: frozenset[int] = frozenset({2, 4, 9, 11})  # ii, iii, vi, vii


def midi_to_hz(midi: float) -> float:
    """Equal-tempered frequency of a MIDI note number."""
    return float(440.0 * 2.0 ** ((midi - 69.0) / 12.0))


def _envelope(
    length: int, rate: int, decay: float, attack_sec: float = 0.002
) -> NDArray[np.float32]:
    """Fast-attack, exponential-decay amplitude envelope."""
    t = np.arange(length, dtype=np.float64) / rate
    attack = np.clip(t / max(attack_sec, 1e-6), 0.0, 1.0)
    return (attack * np.exp(-t * decay)).astype(np.float32)


def _add(target: NDArray[np.float32], start: int, hit: NDArray[np.float32], gain: float) -> None:
    """Adds a mono hit at ``start``, clipped to the buffer, into both channels."""
    if start >= target.shape[0]:
        return
    begin = max(0, start)
    offset = begin - start
    end = min(target.shape[0], start + hit.shape[0])
    if end <= begin:
        return
    target[begin:end, 0] += hit[offset : offset + end - begin] * gain
    target[begin:end, 1] += hit[offset : offset + end - begin] * gain


def _add_stereo(
    target: NDArray[np.float32], start: int, left: NDArray[np.float32], right: NDArray[np.float32]
) -> None:
    """Adds a stereo hit at ``start``, clipped to the buffer."""
    if start >= target.shape[0]:
        return
    begin = max(0, start)
    offset = begin - start
    end = min(target.shape[0], start + left.shape[0])
    if end <= begin:
        return
    target[begin:end, 0] += left[offset : offset + end - begin]
    target[begin:end, 1] += right[offset : offset + end - begin]


def _kick(rate: int) -> NDArray[np.float32]:
    """A short pitch-swept sine, the classic synthetic kick."""
    length = round(0.18 * rate)
    t = np.arange(length, dtype=np.float64) / rate
    frequency = 45.0 + 85.0 * np.exp(-t * 28.0)
    phase = 2.0 * np.pi * np.cumsum(frequency) / rate
    return (np.sin(phase) * _envelope(length, rate, 16.0)).astype(np.float32)


def _snare(rate: int, rng: np.random.Generator) -> NDArray[np.float32]:
    """Noise plus a short body tone."""
    length = round(0.16 * rate)
    noise = rng.standard_normal(length).astype(np.float32)
    body = np.sin(2.0 * np.pi * 185.0 * np.arange(length) / rate).astype(np.float32)
    return ((0.7 * noise + 0.5 * body) * _envelope(length, rate, 30.0)).astype(np.float32)


def _hat(rate: int, rng: np.random.Generator) -> NDArray[np.float32]:
    """High-passed noise (first difference) with a very short decay."""
    length = round(0.045 * rate)
    noise = rng.standard_normal(length).astype(np.float32)
    high = np.diff(noise, prepend=np.float32(0.0))
    return (high * _envelope(length, rate, 90.0)).astype(np.float32)


def _note(rate: int, frequency: float, seconds: float, decay: float) -> NDArray[np.float32]:
    """A sine note with a fast attack and an adjustable decay."""
    length = max(1, round(seconds * rate))
    t = np.arange(length, dtype=np.float64) / rate
    wave = np.sin(2.0 * np.pi * frequency * t)
    return (wave * _envelope(length, rate, decay)).astype(np.float32)


def _chord(
    rate: int, frequencies: tuple[float, ...], seconds: float, detune_cents: float
) -> tuple[NDArray[np.float32], NDArray[np.float32]]:
    """A slow pad chord, slightly detuned between the channels for width."""
    length = max(1, round(seconds * rate))
    t = np.arange(length, dtype=np.float64) / rate
    fade = 0.08
    attack = np.clip(t / fade, 0.0, 1.0)
    release = np.clip((seconds - t) / fade, 0.0, 1.0)
    envelope = (attack * release).astype(np.float32)
    left = np.zeros(length, dtype=np.float64)
    right = np.zeros(length, dtype=np.float64)
    for index, frequency in enumerate(frequencies):
        left += np.sin(2.0 * np.pi * frequency * t + 0.13 * index)
        rat = 2.0 ** (detune_cents / 1200.0)
        right += np.sin(2.0 * np.pi * frequency * rat * t + 0.31 * index)
    normaliser = 1.0 / max(1, len(frequencies))
    return (
        (left * envelope * normaliser).astype(np.float32),
        (right * envelope * normaliser).astype(np.float32),
    )


def _scale_degree_pitch(key: KeySpec, degree: int, octave: int = 0) -> float:
    """A MIDI frequency for a scale degree (0 = tonic) in the key.

    C3 (MIDI 48) plus the tonic pitch class puts the bass around A3 for A minor,
    which is the register the gate's chroma and key fit expect.
    """
    return midi_to_hz(48 + key.tonic_pc + 12 * octave + degree)


def synthesize(
    bpm: float,
    time_signature: tuple[int, int],
    key: KeySpec,
    *,
    start_sec: float,
    duration_sec: float,
    seed: int = 0,
    sample_rate: int = 48_000,
) -> Audio:
    """Renders stereo audio for the absolute musical window ``[start, start + duration)``.

    ``start_sec`` is the position on the song's timeline: ``0`` is the song start, so
    a forward candidate starts at ``context_duration - overlap`` and a backward one
    at ``-total_duration``. The pattern keeps its phase across that window, which is
    what makes the overlap musically continuous.
    """
    if duration_sec <= 0.0:
        raise ValueError(f"duration_sec must be positive, got {duration_sec}")
    rate = sample_rate
    beats_per_bar = time_signature[0]
    beat_sec = 60.0 / bpm
    bar_sec = beat_sec * beats_per_bar
    frames = max(1, round(duration_sec * rate))
    out = np.zeros((frames, 2), dtype=np.float32)
    rng = np.random.default_rng(seed)
    progression = _MINOR_PROGRESSION if key.mode == "minor" else _MAJOR_PROGRESSION
    rotation = int(rng.integers(0, len(progression)))
    detune = float(rng.uniform(-4.0, 4.0))

    kick = _kick(rate)
    snare = _snare(rate, rng)
    hat = _hat(rate, rng)
    # A little headroom before the window, so a hit that starts just before it still
    # rings into the candidate instead of being cut at a non-zero sample.
    preroll = round(0.25 * bar_sec)
    first_beat = int(np.floor((start_sec - preroll) / beat_sec))
    last_beat = int(np.ceil((start_sec + duration_sec) / beat_sec))

    for beat in range(first_beat, last_beat + 1):
        position = beat * beat_sec
        offset = round((position - start_sec) * rate)
        in_bar = beat % beats_per_bar
        if in_bar == 0 or in_bar == beats_per_bar // 2:
            _add(out, offset, kick, 0.45 * float(rng.uniform(0.9, 1.0)))
        if beats_per_bar >= 4 and in_bar in (1, 3):
            _add(out, offset, snare, 0.18 * float(rng.uniform(0.85, 1.0)))
        if beat % 2 == 1:
            _add(out, offset, hat, 0.08 * float(rng.uniform(0.7, 1.0)))
        # Bass on every beat, an octave below the pad root.
        bar = int(np.floor(position / bar_sec))
        degree = progression[(bar + rotation) % len(progression)]
        bass = _note(rate, _scale_degree_pitch(key, degree), beat_sec * 0.9, 3.5)
        _add(out, offset, bass, 0.20 * float(rng.uniform(0.9, 1.0)))

    first_bar = int(np.floor((start_sec - preroll) / bar_sec))
    last_bar = int(np.ceil((start_sec + duration_sec) / bar_sec))
    for bar in range(first_bar, last_bar + 1):
        position = bar * bar_sec
        offset = round((position - start_sec) * rate)
        degree = progression[(bar + rotation) % len(progression)]
        minor_offsets = _MINOR_TRIAD_OFFSETS if key.mode == "minor" else _MAJOR_MINOR_TRIAD_OFFSETS
        third = 3 if degree in minor_offsets else 4
        root = _scale_degree_pitch(key, degree, octave=1)
        chord = tuple(root * 2.0 ** (semitones / 12.0) for semitones in (0, third, 7))
        left, right = _chord(rate, chord, bar_sec, detune)
        _add_stereo(out, offset, left * np.float32(0.12), right * np.float32(0.12))

    return Audio(np.ascontiguousarray(np.clip(out, -1.0, 1.0)), rate)


class FakeBackend:
    """The no-model backend for tests and the live e2e."""

    name = "fake"
    version = "1"
    capabilities = frozenset({"generate.extend"})
    max_duration_sec = 600.0
    supports_audio_context = True
    supports_lyrics = False
    supports_preview_tier = True

    def generate(
        self,
        req: GenRequest,
        tier: Tier,
        n: int,
        on_progress: Callable[[float], None],
    ) -> list[GenOutput]:
        """Synthesises ``n`` seeded continuations of the context."""
        if tier not in ("preview", "hq"):
            raise ValueError(f"unknown tier {tier!r}")
        if n < 1:
            raise ValueError(f"n must be >= 1, got {n}")
        started = time.perf_counter()
        outputs: list[GenOutput] = []
        # The candidate's head is the context edge, so it starts one overlap before
        # it (forward) or ends there (backward), exactly like a real backend.
        start = req.context.duration_sec - req.overlap_sec
        if req.direction == "backward":
            start = -req.total_duration_sec
        target_db = rms_db(req.context)
        for index in range(n):
            seed = (req.seed + index) & 0xFFFFFFFF
            audio = synthesize(
                req.bpm,
                req.time_signature,
                req.key,
                start_sec=start,
                duration_sec=req.total_duration_sec,
                seed=seed,
                sample_rate=req.context.sample_rate,
            )
            if audio.sample_rate != req.context.sample_rate:
                raise ValueError("the fake backend must render at the context's rate")
            level = rms(audio)
            if level > 0.0 and np.isfinite(target_db):
                # Continue the context's loudness rather than normalising to full scale.
                gain = 10.0 ** ((target_db - rms_db(audio)) / 20.0)
                peak = float(np.max(np.abs(audio.samples)))
                if peak > 0.0:
                    gain = min(gain, 0.95 / peak)
                audio = scale(audio, min(gain, 8.0))
            outputs.append(
                GenOutput(
                    audio=audio,
                    seed=seed,
                    model=self.name,
                    model_version=self.version,
                    timings=GenTimings(
                        generate_sec=time.perf_counter() - started,
                        download_sec=0.0,
                        total_sec=time.perf_counter() - started,
                    ),
                )
            )
            on_progress((index + 1) / n)
        return outputs

    def warmup(self) -> None:
        """No-op: there is no model to load (09 §5's ping is cheap)."""


__all__ = ["FakeBackend", "midi_to_hz", "synthesize"]
