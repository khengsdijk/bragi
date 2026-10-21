"""Audio IO and level helpers for the generation worker.

The worker framework hands over bytes and takes bytes back, so everything is in
memory. Working audio is the gate package's :class:`Audio` (48 kHz, float32,
``(frames, channels)``); a candidate is stored as 24-bit FLAC, the same working
format as the analysis worker's stems.
"""

from __future__ import annotations

import io
import math

import numpy as np
import soundfile as sf

from bragi_generate.postprocess.types import Audio

#: The engine renders context at 48 kHz (02 §2), so generation speaks it too.
WORKING_RATE = 48_000


def decode(data: bytes, *, expected_rate: int = WORKING_RATE) -> Audio:
    """Decodes WAV/FLAC bytes into stereo float32 :class:`Audio` at ``expected_rate``.

    A mono file is duplicated to stereo; any other channel count is squeezed to the
    first two channels. A different sample rate is rejected rather than silently
    resampled: the context contract is 48 kHz (02 §2, 09 §2.1).
    """
    samples, rate = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
    if rate != expected_rate:
        raise ValueError(f"expected {expected_rate} Hz audio, got {rate} Hz")
    if samples.shape[1] == 0:
        raise ValueError("audio has no channels")
    if samples.shape[1] == 1:
        samples = np.repeat(samples, 2, axis=1)
    elif samples.shape[1] > 2:
        samples = samples[:, :2]
    return Audio(np.ascontiguousarray(samples, dtype=np.float32), rate)


def encode_flac(audio: Audio) -> bytes:
    """Encodes a candidate as 24-bit FLAC at its own rate."""
    buffer = io.BytesIO()
    sf.write(buffer, audio.samples, audio.sample_rate, format="FLAC", subtype="PCM_24")
    return buffer.getvalue()


def encode_wav(audio: Audio) -> bytes:
    """Encodes float32 WAV, for a backend that wants the source in memory first."""
    buffer = io.BytesIO()
    sf.write(buffer, audio.samples, audio.sample_rate, format="WAV", subtype="FLOAT")
    return buffer.getvalue()


def rms(audio: Audio) -> float:
    """Root-mean-square of every sample and channel."""
    if audio.frames == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(audio.samples, dtype=np.float64))))


def rms_db(audio: Audio) -> float:
    """RMS in dBFS; ``-inf`` for silence."""
    level = rms(audio)
    return 20.0 * math.log10(level) if level > 0.0 else float("-inf")


def scale(audio: Audio, gain: float) -> Audio:
    """The same audio multiplied by ``gain``, clipped to full scale."""
    scaled = np.clip(audio.samples * np.float32(gain), -1.0, 1.0)
    return Audio(np.ascontiguousarray(scaled, dtype=np.float32), audio.sample_rate)


__all__ = [
    "WORKING_RATE",
    "decode",
    "encode_flac",
    "encode_wav",
    "rms",
    "rms_db",
    "scale",
]
