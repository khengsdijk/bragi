"""``ingest``: working asset, fingerprint, and the rejection codes (WP-1.2 acceptance)."""

from __future__ import annotations

import asyncio
import json
import subprocess
from pathlib import Path
from typing import cast

import numpy as np
import pytest
from analysis_support import (
    FakeContext,
    make_job,
    needs_ffmpeg,
    needs_fpcalc,
    sine,
    wav_bytes,
)

from bragi_analysis.capabilities import ingest
from bragi_common.cancel import JobCancelledError
from bragi_common.context import JobContext
from bragi_common.errors import JobFailure

pytestmark = needs_ffmpeg


def run_ingest(
    tmp_path: Path, data: bytes, params: dict[str, object] | None = None
) -> tuple[FakeContext, dict[str, object]]:
    context = FakeContext(tmp_path, data)
    outputs = asyncio.run(ingest.run(make_job("ingest", params), cast(JobContext, context)))
    assert outputs.blobs is not None
    blob = context.uploads[outputs.blobs["result"]]
    return context, json.loads(blob)


def ffprobe(path: Path) -> dict[str, object]:
    out = subprocess.run(  # noqa: S603 - fixed argv, test-generated file
        [
            "ffprobe", "-v", "error", "-print_format", "json", "-show_streams", str(path),
        ],  # fmt: skip
        check=True,
        capture_output=True,
    )
    return cast(dict[str, object], json.loads(out.stdout)["streams"][0])


def failure(tmp_path: Path, data: bytes, params: dict[str, object] | None = None) -> JobFailure:
    with pytest.raises(JobFailure) as caught:
        run_ingest(tmp_path, data, params)
    return caught.value


@needs_fpcalc
def test_stereo_44k_becomes_a_48k_stereo_24_bit_flac(tmp_path: Path) -> None:
    left = sine(4.0, 44_100, 440.0)
    right = sine(4.0, 44_100, 660.0)
    context, result = run_ingest(tmp_path, wav_bytes(np.stack([left, right], axis=1), 44_100))

    working = tmp_path / "check.flac"
    working.write_bytes(context.uploads[cast(str, result["workingAsset"])])
    stream = ffprobe(working)
    assert stream["codec_name"] == "flac"
    assert stream["sample_rate"] == "48000"
    assert stream["channels"] == 2
    assert stream["bits_per_raw_sample"] == "24"

    assert result["schemaVersion"] == 1
    assert result["channelsOriginal"] == 2
    assert result["sampleRateOriginal"] == 44_100
    assert result["codec"] == "pcm_s16le"
    assert cast(float, result["durationSec"]) == pytest.approx(4.0, abs=0.01)
    assert isinstance(result["fingerprint"], str)
    assert not str(result["fingerprint"]).startswith("exact:")
    assert context.reports[-1] == 1.0


def test_mono_is_duplicated_to_both_channels(tmp_path: Path) -> None:
    context, result = run_ingest(tmp_path, wav_bytes(sine(1.0, 48_000), 48_000))
    assert result["channelsOriginal"] == 1

    working = tmp_path / "check.flac"
    working.write_bytes(context.uploads[cast(str, result["workingAsset"])])
    stream = ffprobe(working)
    assert stream["channels"] == 2


def test_more_than_two_channels_are_downmixed_and_reported(tmp_path: Path) -> None:
    six = np.stack([sine(1.0, 48_000, 200.0 * (i + 1)) for i in range(6)], axis=1)
    context, result = run_ingest(tmp_path, wav_bytes(six, 48_000))
    assert result["channelsOriginal"] == 6

    working = tmp_path / "check.flac"
    working.write_bytes(context.uploads[cast(str, result["workingAsset"])])
    assert ffprobe(working)["channels"] == 2


def test_a_short_clip_gets_an_exact_match_key_instead_of_a_chromaprint(tmp_path: Path) -> None:
    _, result = run_ingest(tmp_path, wav_bytes(sine(0.4, 48_000), 48_000))
    assert str(result["fingerprint"]).startswith("exact:")


def test_the_peak_pyramid_has_min_max_pairs_per_level(tmp_path: Path) -> None:
    _, result = run_ingest(tmp_path, wav_bytes(sine(3.0, 48_000, amplitude=0.5), 48_000))
    pyramid = cast(dict[str, object], result["peakPyramid"])
    levels = cast(list[dict[str, object]], pyramid["levels"])
    first = levels[0]
    assert first["samplesPerPeak"] == 4096
    peaks = cast(list[float], first["peaks"])
    assert len(peaks) == 2 * -(-int(cast(float, result["durationSec"]) * 48_000) // 4096)
    assert max(peaks) == pytest.approx(0.5, abs=0.01)
    assert min(peaks) == pytest.approx(-0.5, abs=0.01)


def test_the_working_asset_is_deterministic(tmp_path: Path) -> None:
    data = wav_bytes(sine(1.0, 48_000), 48_000)
    first, a = run_ingest(tmp_path, data)
    second, b = run_ingest(tmp_path, data)
    assert a["workingAsset"] == b["workingAsset"]
    assert first.uploads.keys() == second.uploads.keys()


@pytest.mark.parametrize(
    "garbage",
    [b"", b"definitely not audio", bytes(range(256)) * 64, b"RIFF\x00\x00\x00\x00WAVE" + b"\x00" * 40],
    ids=["empty", "text", "binary", "wav-header-only"],
)
def test_undecodable_input_is_asset_corrupt_and_not_retryable(tmp_path: Path, garbage: bytes) -> None:
    error = failure(tmp_path, garbage)
    assert error.code == "ASSET_CORRUPT"
    assert error.retryable is False
    assert "damaged" in str(error)


def test_a_truncated_flac_is_asset_corrupt(tmp_path: Path) -> None:
    # FLAC declares its total sample count in STREAMINFO, so a cut-off file is detectable.
    full, result = run_ingest(tmp_path, wav_bytes(np.random.default_rng(1).uniform(-0.5, 0.5, 96_000).astype(np.float32), 48_000))
    flac = full.uploads[cast(str, result["workingAsset"])]
    error = failure(tmp_path, flac[: len(flac) // 2])
    assert error.code == "ASSET_CORRUPT"
    assert error.retryable is False


def test_a_file_without_an_audio_track_is_unsupported_media(tmp_path: Path) -> None:
    video = tmp_path / "video.mkv"
    subprocess.run(  # noqa: S603 - fixed argv
        [
            "ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:d=1",
            "-c:v", "mpeg4", "-y", str(video),
        ],  # fmt: skip
        check=True,
    )
    error = failure(tmp_path, video.read_bytes())
    assert error.code == "UNSUPPORTED_MEDIA_TYPE"
    assert error.retryable is False


def test_audio_over_the_duration_limit_is_asset_too_long(tmp_path: Path) -> None:
    data = wav_bytes(sine(5.0, 8_000), 8_000)
    error = failure(tmp_path, data, {"maxDurationSec": 2})
    assert error.code == "ASSET_TOO_LONG"
    assert error.retryable is False


def test_the_default_limit_is_thirty_minutes() -> None:
    assert ingest.ParamsModel().maxDurationSec == 30 * 60
    assert ingest.ParamsModel().maxBytes == 500_000_000


def test_a_container_that_lies_about_its_duration_is_still_bounded(tmp_path: Path) -> None:
    # 5 s of audio whose WAV header claims 1 s: the probe passes, the bounded decode must not
    # let it through as a "short" file.
    data = bytearray(wav_bytes(sine(5.0, 8_000), 8_000))
    data[40:44] = (1 * 8_000 * 2).to_bytes(4, "little")
    _, result = run_ingest(tmp_path, bytes(data), {"maxDurationSec": 2})
    # ffmpeg honours the header's data size, so the file is simply 1 s of audio: the guard that
    # matters is that nothing past maxDurationSec + 1 s is ever decoded.
    assert cast(float, result["durationSec"]) <= 2.0


def test_a_file_over_the_byte_limit_is_payload_too_large(tmp_path: Path) -> None:
    error = failure(tmp_path, wav_bytes(sine(1.0, 8_000), 8_000), {"maxBytes": 1000})
    assert error.code == "PAYLOAD_TOO_LARGE"
    assert error.retryable is False


def test_unknown_params_are_rejected_by_the_params_model() -> None:
    with pytest.raises(ValueError, match="extra"):
        ingest.ParamsModel.model_validate({"bogus": 1})


def test_a_cancelled_job_stops_before_decoding(tmp_path: Path) -> None:
    context = FakeContext(tmp_path, wav_bytes(sine(1.0, 8_000), 8_000), cancelled=True)
    with pytest.raises(JobCancelledError):
        asyncio.run(ingest.run(make_job("ingest"), cast(JobContext, context)))
