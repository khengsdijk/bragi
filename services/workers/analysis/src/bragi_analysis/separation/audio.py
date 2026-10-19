"""FLAC encode/decode for working assets and stems (``specs/04`` §3.1: 48 kHz, 24-bit).

Only this module and the capability touch ``soundfile``. Everything is in memory: the
worker framework hands over bytes and takes bytes back (``ctx.download`` / ``ctx.upload``).
"""

from __future__ import annotations

import io

import numpy as np
import soundfile as sf

from bragi_analysis.separation.pipeline import Audio


def decode_flac(data: bytes) -> tuple[Audio, int]:
    """Decodes FLAC (or any libsndfile format) to ``(channels, samples)`` float64 and its rate."""
    samples, rate = sf.read(io.BytesIO(data), dtype="float64", always_2d=True)
    return np.ascontiguousarray(samples.T), int(rate)


def encode_flac(audio: Audio, rate: int) -> bytes:
    """Encodes ``(channels, samples)`` float audio as 24-bit FLAC."""
    buffer = io.BytesIO()
    sf.write(buffer, audio.T, rate, format="FLAC", subtype="PCM_24")
    return buffer.getvalue()
