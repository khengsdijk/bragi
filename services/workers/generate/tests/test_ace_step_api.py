"""Tests for the ACE-Step HTTP client against a fake server (no model)."""

from __future__ import annotations

import json
import threading
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Literal

import pytest

from bragi_generate.backends.ace_step_api import (
    AceStepClient,
    AceStepError,
    AudioFormat,
    ExtendRequest,
    build_extend_payload,
    parse_task_result,
)

TASK_ID = "task-1"
AUDIO = b"/RIFFfake-wave"


class FakeAceStep:
    """A tiny in-process ACE-Step stand-in that records requests."""

    def __init__(self) -> None:
        self.requests: list[tuple[str, str, dict[str, object] | None]] = []
        self.status_calls = 0
        self.fail_health = False
        self.fail_task = False
        self.release_http_error: int | None = None
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args: object) -> None:
                """Silence the default request log."""

            def _send(self, status: int, payload: dict[str, object]) -> None:
                body = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _record(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b""
                body = json.loads(raw) if raw else None
                fake.requests.append((self.command, self.path, body))

            def do_GET(self) -> None:
                self._record()
                if self.path == "/health":
                    if fake.fail_health:
                        self._send(500, {"detail": "down"})
                    else:
                        self._send(
                            200,
                            {
                                "data": {
                                    "status": "ok",
                                    "service": "ACE-Step API",
                                    "version": "1.0",
                                },
                                "code": 200,
                                "error": None,
                            },
                        )
                elif self.path.startswith("/v1/audio"):
                    self.send_response(200)
                    self.send_header("Content-Type", "audio/wav")
                    self.send_header("Content-Length", str(len(AUDIO)))
                    self.end_headers()
                    self.wfile.write(AUDIO)
                else:
                    self._send(404, {"detail": "not found"})

            def do_POST(self) -> None:
                self._record()
                if self.path == "/release_task":
                    if fake.release_http_error is not None:
                        self._send(fake.release_http_error, {"detail": "bad request"})
                        return
                    self._send(
                        200,
                        {
                            "data": {
                                "task_id": TASK_ID,
                                "status": "queued",
                                "queue_position": 1,
                            },
                            "code": 200,
                            "error": None,
                        },
                    )
                elif self.path == "/query_result":
                    fake.status_calls += 1
                    status = 2 if fake.fail_task else (0 if fake.status_calls == 1 else 1)
                    result = (
                        ""
                        if status == 0
                        else json.dumps(
                            [
                                {
                                    "file": "/v1/audio?path=%2Ftmp%2Fout.wav",
                                    "status": status,
                                    "seed_value": "1234",
                                    "dit_model": "acestep-v15-turbo",
                                    "lm_model": None,
                                    "prompt": "continue",
                                    "metas": {"bpm": 120},
                                }
                            ]
                        )
                    )
                    self._send(
                        200,
                        {
                            "data": [{"task_id": TASK_ID, "status": status, "result": result}],
                            "code": 200,
                            "error": None,
                        },
                    )
                else:
                    self._send(404, {"detail": "not found"})

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    def __enter__(self) -> FakeAceStep:
        self._thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self._server.shutdown()
        self._server.server_close()

    @property
    def base_url(self) -> str:
        host = str(self._server.server_address[0])
        port = int(self._server.server_address[1])
        return f"http://{host}:{port}"


def make_request(
    *,
    src_audio_path: str = "/bragi/context.wav",
    src_duration_sec: float = 30.0,
    extend_sec: float = 8.0,
    overlap_sec: float = 2.0,
    caption: str = "warm analog outro",
    lyrics: str = "",
    instrumental: bool = True,
    bpm: int | None = 120,
    key_scale: str = "Am",
    time_signature: str = "4",
    seed: int | None = 42,
    steps: int = 8,
    guidance_scale: float = 7.0,
    batch_size: int = 1,
    repaint_mode: Literal["conservative", "balanced", "aggressive"] = "balanced",
    repaint_strength: float = 0.5,
    output_format: AudioFormat = "wav",
    model: str | None = None,
) -> ExtendRequest:
    return ExtendRequest(
        src_audio_path=src_audio_path,
        src_duration_sec=src_duration_sec,
        extend_sec=extend_sec,
        overlap_sec=overlap_sec,
        caption=caption,
        lyrics=lyrics,
        instrumental=instrumental,
        bpm=bpm,
        key_scale=key_scale,
        time_signature=time_signature,
        seed=seed,
        steps=steps,
        guidance_scale=guidance_scale,
        batch_size=batch_size,
        repaint_mode=repaint_mode,
        repaint_strength=repaint_strength,
        output_format=output_format,
        model=model,
    )


def test_extend_payload_maps_to_an_explicit_repaint_span() -> None:
    payload = build_extend_payload(make_request())

    assert payload["task_type"] == "repaint"
    assert payload["src_audio_path"] == "/bragi/context.wav"
    assert payload["repainting_start"] == 28.0
    assert payload["repainting_end"] == 38.0
    assert payload["chunk_mask_mode"] == "explicit"
    assert payload["prompt"] == "warm analog outro"
    assert payload["lyrics"] == ""
    assert payload["bpm"] == 120
    assert payload["key_scale"] == "Am"
    assert payload["time_signature"] == "4"
    assert payload["use_random_seed"] is False
    assert payload["seed"] == 42
    assert payload["audio_format"] == "wav"
    assert payload["thinking"] is False


def test_extend_payload_uses_random_seed_and_fallback_caption() -> None:
    payload = build_extend_payload(make_request(seed=None, caption=""))

    assert payload["use_random_seed"] is True
    assert "seed" not in payload
    assert payload["prompt"] == "continue the music seamlessly"


def test_extend_payload_keeps_lyrics_when_not_instrumental() -> None:
    payload = build_extend_payload(make_request(instrumental=False, lyrics="la la"))

    assert payload["lyrics"] == "la la"


@pytest.mark.parametrize(
    ("build", "message"),
    [
        (lambda: make_request(src_audio_path=""), "src_audio_path"),
        (lambda: make_request(src_duration_sec=0.0), "src_duration_sec"),
        (lambda: make_request(overlap_sec=30.0), "overlap_sec"),
        (lambda: make_request(extend_sec=0.0), "extend_sec"),
        (lambda: make_request(src_duration_sec=500.0, extend_sec=120.0), "600"),
        (lambda: make_request(steps=0), "steps"),
        (lambda: make_request(batch_size=9), "batch_size"),
        (lambda: make_request(repaint_strength=1.5), "repaint_strength"),
    ],
)
def test_extend_request_rejects_invalid_ranges(
    build: Callable[[], ExtendRequest], message: str
) -> None:
    with pytest.raises(ValueError, match=message):
        build()


def test_health_unwraps_the_envelope() -> None:
    with FakeAceStep() as fake:
        health = AceStepClient(fake.base_url).health()

    assert health.status == "ok"
    assert health.service == "ACE-Step API"
    assert health.version == "1.0"


def test_health_raises_on_http_error() -> None:
    with FakeAceStep() as fake:
        fake.fail_health = True
        with pytest.raises(AceStepError, match="HTTP 500"):
            AceStepClient(fake.base_url).health()


def test_extend_submits_polls_and_downloads(tmp_path: Path) -> None:
    output = tmp_path / "out.wav"
    with FakeAceStep() as fake:
        client = AceStepClient(fake.base_url)
        result = client.extend(make_request(), output, poll_interval_sec=0.001)

        assert result.audio == AUDIO
        assert output.read_bytes() == AUDIO
        assert result.entry.seed_values == (1234,)
        assert result.entry.dit_model == "acestep-v15-turbo"

        methods = [(method, path) for method, path, _ in fake.requests]
        assert methods == [
            ("POST", "/release_task"),
            ("POST", "/query_result"),
            ("POST", "/query_result"),
            ("GET", "/v1/audio?path=%2Ftmp%2Fout.wav"),
        ]
        submit_body = fake.requests[0][2]
        assert submit_body is not None
        assert submit_body["repainting_start"] == 28.0
        assert submit_body["repainting_end"] == 38.0
        assert fake.requests[1][2] == {"task_id_list": [TASK_ID]}


def test_failed_task_raises() -> None:
    with FakeAceStep() as fake:
        fake.fail_task = True
        client = AceStepClient(fake.base_url)
        with pytest.raises(AceStepError, match="failed"):
            client.wait(TASK_ID, poll_interval_sec=0.001)


def test_release_task_http_error_is_reported() -> None:
    with FakeAceStep() as fake:
        fake.release_http_error = 400
        client = AceStepClient(fake.base_url)
        with pytest.raises(AceStepError, match="HTTP 400"):
            client.submit_extend(make_request())


def test_parse_task_result_handles_queued_and_missing_entries() -> None:
    queued = parse_task_result(TASK_ID, [{"task_id": TASK_ID, "status": 0, "result": ""}])
    assert queued.status == 0
    assert queued.entries == ()
    assert not queued.succeeded

    with pytest.raises(AceStepError, match="not in the query_result"):
        parse_task_result("other", [{"task_id": TASK_ID, "status": 0}])


def test_outer_success_with_a_running_entry_is_not_ready() -> None:
    running = parse_task_result(
        TASK_ID,
        [
            {
                "task_id": TASK_ID,
                "status": 1,
                "result": json.dumps([{"file": "", "status": 0, "stage": "running"}]),
            }
        ],
    )
    assert running.succeeded
    assert not running.ready

    done = parse_task_result(
        TASK_ID,
        [
            {
                "task_id": TASK_ID,
                "status": 1,
                "result": json.dumps([{"file": "/v1/audio?path=x.wav", "status": 1}]),
            }
        ],
    )
    assert done.ready
