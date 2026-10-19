"""Decoding and encoding through ffmpeg, plus the Chromaprint fingerprint.

``specs/04`` §3.1 names ffmpeg for decoding and Chromaprint for the fingerprint.
Both run as subprocesses of the worker, so a hostile file can only crash a child
process, never the worker. Failures are mapped to the stable error codes of
``packages/schemas/api/errors.json`` (04 §10).
"""

from __future__ import annotations

import asyncio
import json
import shutil
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from numpy.typing import NDArray

from bragi_common.errors import JobFailure

#: The user-facing reason of 04 §10 for undecodable input.
CORRUPT_MESSAGE = "This file seems damaged or isn't audio."

#: A decode that yields less than this share of the declared duration is truncated.
TRUNCATION_TOLERANCE = 0.95

type Pcm = NDArray[np.float32]


@dataclass(frozen=True)
class Probe:
    """What ffprobe reports about the first audio stream."""

    duration_sec: float | None
    channels: int
    sample_rate: int
    codec: str


def require_binary(name: str) -> str:
    """Returns the path of an OS binary the worker image must provide."""
    path = shutil.which(name)
    if path is None:
        raise RuntimeError(
            f"{name} is not installed on this worker (see services/workers/Dockerfile)"
        )
    return path


async def _run(*args: str, stdin: bytes | None = None) -> tuple[int, bytes, bytes]:
    process = await asyncio.create_subprocess_exec(
        *args,
        stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await process.communicate(stdin)
    return process.returncode or 0, stdout, stderr


async def probe(path: Path) -> Probe:
    """Inspects a file, raising ``ASSET_CORRUPT`` or ``UNSUPPORTED_MEDIA_TYPE``."""
    code, stdout, _ = await _run(
        require_binary("ffprobe"),
        "-v", "error",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        str(path),
    )  # fmt: skip
    if code != 0:
        raise JobFailure("ASSET_CORRUPT", CORRUPT_MESSAGE)
    try:
        info = json.loads(stdout)
    except ValueError as error:
        raise JobFailure("ASSET_CORRUPT", CORRUPT_MESSAGE) from error

    streams = info.get("streams", [])
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if audio is None:
        if streams:
            raise JobFailure("UNSUPPORTED_MEDIA_TYPE", "This file has no audio track.")
        raise JobFailure("ASSET_CORRUPT", CORRUPT_MESSAGE)

    raw_duration = audio.get("duration") or info.get("format", {}).get("duration")
    try:
        duration = float(raw_duration) if raw_duration is not None else None
    except ValueError:
        duration = None
    try:
        channels = int(audio["channels"])
        sample_rate = int(audio["sample_rate"])
    except (KeyError, ValueError) as error:
        raise JobFailure("ASSET_CORRUPT", CORRUPT_MESSAGE) from error
    if channels < 1 or sample_rate < 1:
        raise JobFailure("ASSET_CORRUPT", CORRUPT_MESSAGE)
    return Probe(
        duration_sec=duration if duration and duration > 0 else None,
        channels=channels,
        sample_rate=sample_rate,
        codec=str(audio.get("codec_name") or "unknown"),
    )


async def decode_pcm(
    path: Path,
    *,
    sample_rate: int,
    channels: int,
    max_seconds: float | None = None,
    declared_duration_sec: float | None = None,
    source_channels: int | None = None,
) -> Pcm:
    """Decodes the first audio stream to float32 PCM of shape ``(samples, channels)``.

    Mono input is duplicated at unity gain when ``channels == 2`` (ffmpeg's own
    up-mix would apply a -3 dB pan law) and more than two channels are downmixed
    with ffmpeg's standard matrix (04 §3.1). Pass ``source_channels`` from the
    probe to enable the duplication.

    Raises:
        JobFailure: ``ASSET_CORRUPT`` when nothing decodes, or when much less audio
            decodes than the container declares (a truncated file).
    """
    args = [
        require_binary("ffmpeg"),
        "-v", "error", "-nostdin",
        "-i", str(path),
        "-map", "0:a:0", "-vn",
    ]  # fmt: skip
    if source_channels == 1 and channels == 2:
        args += ["-af", "pan=stereo|c0=c0|c1=c0"]
    else:
        args += ["-ac", str(channels)]
    args += ["-ar", str(sample_rate)]
    if max_seconds is not None:
        args += ["-t", f"{max_seconds:.3f}"]
    args += ["-f", "f32le", "-"]
    code, stdout, _ = await _run(*args)
    usable = len(stdout) - len(stdout) % (4 * channels)
    if code != 0 or usable == 0:
        raise JobFailure("ASSET_CORRUPT", CORRUPT_MESSAGE)
    pcm = np.frombuffer(stdout[:usable], dtype="<f4").reshape(-1, channels)

    decoded_sec = pcm.shape[0] / sample_rate
    if (
        declared_duration_sec is not None
        and (max_seconds is None or declared_duration_sec <= max_seconds)
        and decoded_sec < declared_duration_sec * TRUNCATION_TOLERANCE
    ):
        raise JobFailure("ASSET_CORRUPT", "This file seems to be cut short or damaged.")
    return np.array(pcm, dtype=np.float32)


async def encode_flac_24(pcm: Pcm, sample_rate: int, destination: Path) -> None:
    """Encodes float32 PCM as a deterministic 24-bit FLAC (a content-addressable output)."""
    channels = pcm.shape[1]
    code, _, stderr = await _run(
        require_binary("ffmpeg"),
        "-v", "error", "-nostdin", "-y",
        "-f", "f32le", "-ar", str(sample_rate), "-ac", str(channels), "-i", "-",
        "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact",
        "-c:a", "flac", "-sample_fmt", "s32", "-bits_per_raw_sample", "24",
        str(destination),
        stdin=np.ascontiguousarray(pcm, dtype="<f4").tobytes(),
    )  # fmt: skip
    if code != 0:
        raise RuntimeError(f"FLAC encode failed: {stderr.decode(errors='replace')[:200]}")


async def fingerprint(path: Path) -> str | None:
    """Chromaprint fingerprint of the first two minutes (duplicate detection only, 04 §3.1).

    Returns ``None`` when the audio is too short for Chromaprint to produce one
    (it needs roughly three seconds); the caller substitutes an exact-match key.
    """
    code, stdout, stderr = await _run(require_binary("fpcalc"), "-json", "-length", "120", str(path))
    if code != 0:
        if b"Empty fingerprint" in stderr:
            return None
        raise RuntimeError(f"fpcalc failed: {stderr.decode(errors='replace')[:200]}")
    value = json.loads(stdout).get("fingerprint")
    return value if isinstance(value, str) and value else None
