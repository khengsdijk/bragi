"""A deterministic synthetic backend: drums, bass and a chord pad, no model.

It exists for the tests and the live e2e without ACE-Step (``BRAGI_GENERATION_BACKEND
=fake``). The output follows the requested BPM, meter and key, continues the
context's loudness, and keeps the pattern's phase across the seam, so the quality
gates of 09 §6 run against something musically coherent instead of a tone burst.

Everything is generated from the seed: the same seed gives bit-identical audio, and
a different seed only changes velocities, the progression rotation and a little pad
detune. No audio file is ever committed (13 §1.7).

Two continuations, picked by ``mode`` (or ``BRAGI_FAKE_GENERATION``):

- ``loop`` (default): repeats the context's own last bars. On a real song the
  synthetic pattern's beat does not line up with the music, so the gates reject most
  of it; a loop of the context keeps its tempo, key and phase, so the live e2e gets
  passing candidates on any song. The seed picks how many bars loop (2, 4 or 8) and
  a small gain, so candidates differ.
- ``synth``: the drum/bass/pad pattern above, for tests on synthetic contexts.
"""

from __future__ import annotations

import os
import time
from collections.abc import Callable
from typing import Literal

import numpy as np
from numpy.typing import NDArray

from bragi_generate.audio import rms, rms_db, scale
from bragi_generate.backend import FillRequest, GenOutput, GenRequest, GenTimings, Tier
from bragi_generate.postprocess.seam import crossfade
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


#: Bars a seeded loop repeats, picked by ``seed % 3``.
_LOOP_BARS: tuple[int, ...] = (2, 4, 8)


def loop_context(req: GenRequest, seed: int) -> Audio:
    """Continues the context by repeating its last bars (``loop`` mode).

    A forward candidate starts one overlap before the context end, so its head is the
    context's own tail; a backward one ends one overlap after the context start. The
    loop length and a gain within ±0.5 dB come from the seed.
    """
    context = req.context
    rate = context.sample_rate
    total = max(1, round(req.total_duration_sec * rate))
    overlap = min(round(req.overlap_sec * rate), context.frames)
    bar = max(1, round(req.bar_sec * rate))
    loop = min(bar * _LOOP_BARS[seed % len(_LOOP_BARS)], context.frames)
    samples = context.samples
    if req.direction == "backward":
        samples = samples[::-1]
    head = samples[context.frames - overlap :]
    cycle = samples[context.frames - loop :]
    repeats = -(-(total - overlap) // loop) if total > overlap else 0
    body = np.concatenate([head, *([cycle] * repeats)])[:total]
    if req.direction == "backward":
        body = body[::-1]
    gain = 10.0 ** (((seed % 11) - 5) / 10.0 / 20.0)
    return Audio(np.ascontiguousarray(body * np.float32(gain), dtype=np.float32), rate)


def fill_contexts(req: FillRequest, seed: int) -> Audio:
    """Fills the span by looping the left context and blending into the right one.

    The candidate is the left context's own last bars repeated across the span, then
    an equal-power crossfade over the gate's crossfade length into the right
    context's head. Its first and last ``overlap_bars`` therefore re-create the
    audio around the span exactly, so both splice gates see a real continuation;
    the loop length and a gain within ±0.5 dB come from the seed (like
    :func:`loop_context`).
    """
    rate = req.before.sample_rate
    bar = max(1, round(req.bar_sec * rate))
    overlap = min(round(req.overlap_sec * rate), req.before.frames, req.after.frames)
    lead = round(req.lead_sec * rate)
    gap = round(req.gap_sec * rate)
    middle = gap + 2 * lead
    total = overlap + middle + overlap
    if req.before.frames < lead + overlap or req.after.frames < lead + overlap:
        raise ValueError("each context must hold the lead plus the overlap")
    # The same one-beat, 500 ms-capped crossfade the gates score (03 §8.2).
    fade = max(1, min(round(min(req.beat_sec, 0.5) * rate), overlap))

    left = req.before.trimmed(0, req.before.frames - lead)
    right = req.after.trimmed(lead)
    head = left.samples[-overlap:]
    tail = right.samples[:overlap]
    loop = min(bar * _LOOP_BARS[seed % len(_LOOP_BARS)], left.frames)
    cycle = left.samples[-loop:]
    # ``fade`` extra samples are the loop's own continuation, crossfaded onto the
    # right context's head at the end of the span.
    repeats = -(-(middle + fade) // loop)
    body = np.concatenate([cycle] * repeats)[: middle + fade]

    out = np.zeros((total, head.shape[1]), dtype=np.float32)
    out[:overlap] = head
    out[overlap : overlap + middle] = body[:middle]
    out[overlap + middle : overlap + middle + fade] = crossfade(
        body[middle : middle + fade], tail, fade
    )
    out[overlap + middle + fade :] = tail[fade:overlap]
    gain = 10.0 ** (((seed % 11) - 5) / 10.0 / 20.0)
    return Audio(np.ascontiguousarray(out * np.float32(gain), dtype=np.float32), rate)


class FakeBackend:
    """The no-model backend for tests and the live e2e."""

    name = "fake"
    version = "1"
    capabilities = frozenset({"generate.extend", "generate.inpaint", "generate.transition"})
    max_duration_sec = 600.0
    supports_audio_context = True
    supports_lyrics = False
    supports_preview_tier = True

    def __init__(self, mode: Literal["loop", "synth"] | None = None) -> None:
        """Picks the continuation: ``mode``, else ``BRAGI_FAKE_GENERATION``, else ``loop``."""
        chosen = mode or os.environ.get("BRAGI_FAKE_GENERATION", "loop")
        if chosen not in ("loop", "synth"):
            raise ValueError(f"BRAGI_FAKE_GENERATION must be loop or synth, got {chosen!r}")
        self.mode: Literal["loop", "synth"] = "synth" if chosen == "synth" else "loop"

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
            if self.mode == "loop" and req.context.frames > 0:
                outputs.append(self._output(loop_context(req, seed), seed, started))
                on_progress((index + 1) / n)
                continue
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
            outputs.append(self._output(audio, seed, started))
            on_progress((index + 1) / n)
        return outputs

    def generate_fill(
        self,
        req: FillRequest,
        tier: Tier,
        n: int,
        on_progress: Callable[[float], None],
    ) -> list[GenOutput]:
        """Fills ``n`` seeded spans between the two contexts."""
        if tier not in ("preview", "hq"):
            raise ValueError(f"unknown tier {tier!r}")
        if n < 1:
            raise ValueError(f"n must be >= 1, got {n}")
        started = time.perf_counter()
        outputs: list[GenOutput] = []
        target_db = rms_db(req.before)
        for index in range(n):
            seed = (req.seed + index) & 0xFFFFFFFF
            if self.mode == "loop":
                audio = fill_contexts(req, seed)
            else:
                audio = synthesize(
                    req.bpm,
                    req.time_signature,
                    req.key,
                    start_sec=-(req.overlap_sec + req.lead_sec),
                    duration_sec=req.total_duration_sec,
                    seed=seed,
                    sample_rate=req.before.sample_rate,
                )
                level = rms(audio)
                if level > 0.0 and np.isfinite(target_db):
                    gain = 10.0 ** ((target_db - rms_db(audio)) / 20.0)
                    peak = float(np.max(np.abs(audio.samples)))
                    if peak > 0.0:
                        gain = min(gain, 0.95 / peak)
                    audio = scale(audio, min(gain, 8.0))
            outputs.append(self._output(audio, seed, started))
            on_progress((index + 1) / n)
        return outputs

    def _output(self, audio: Audio, seed: int, started: float) -> GenOutput:
        elapsed = time.perf_counter() - started
        return GenOutput(
            audio=audio,
            seed=seed,
            model=self.name,
            model_version=self.version,
            timings=GenTimings(generate_sec=elapsed, download_sec=0.0, total_sec=elapsed),
        )

    def warmup(self) -> None:
        """No-op: there is no model to load (09 §5's ping is cheap)."""


__all__ = ["FakeBackend", "fill_contexts", "loop_context", "midi_to_hz", "synthesize"]
