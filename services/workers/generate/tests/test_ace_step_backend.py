"""The ACE-Step adapter against a fake HTTP server returning real WAV audio."""

from __future__ import annotations

import json
import threading
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from extend_support import key

from bragi_generate.audio import decode, encode_wav, rms
from bragi_generate.backend import Direction, FillRequest, GenRequest
from bragi_generate.backends.ace_step import (
    AceStepBackend,
    AceStepConfig,
    ace_key,
    caption_for,
)
from bragi_generate.backends.ace_step_api import AceStepClient
from bragi_generate.backends.fake import synthesize
from bragi_generate.postprocess import Audio, KeySpec

RATE = 48_000
TASK_ID = "task-1"


def sine(seconds: float, frequency: float = 220.0, amplitude: float = 0.2) -> Audio:
    """A stereo test tone: its RMS is ``amplitude / sqrt(2)``."""
    frames = round(seconds * RATE)
    t = np.arange(frames, dtype=np.float64) / RATE
    wave = (amplitude * np.sin(2.0 * np.pi * frequency * t)).astype(np.float32)
    return Audio(np.ascontiguousarray(np.stack([wave, wave], axis=1)), RATE)


class FakeAceStep:
    """An ACE-Step stand-in: records payloads and returns whatever ``render`` makes."""

    def __init__(self, render: Callable[[dict[str, Any]], bytes]) -> None:
        self.render = render
        self.payloads: list[dict[str, Any]] = []
        self.inits: list[dict[str, object]] = []
        self.health_calls = 0
        self.audio = b""
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args: object) -> None:
                """Silence the default request log."""

            def _send_json(self, payload: dict[str, object]) -> None:
                body = json.dumps(payload).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length)) if length else {}
                if self.path == "/v1/init":
                    fake.inits.append(body)
                    self._send_json(
                        {"data": {"message": "Model initialization completed"}, "code": 200}
                    )
                elif self.path == "/release_task":
                    fake.payloads.append(body)
                    fake.audio = fake.render(body)
                    self._send_json({"data": {"task_id": TASK_ID}, "code": 200})
                elif self.path == "/query_result":
                    result = [{"file": "/v1/audio?path=out.wav", "status": 1, "seed_value": "1"}]
                    self._send_json(
                        {
                            "data": [
                                {"task_id": TASK_ID, "status": 1, "result": json.dumps(result)}
                            ],
                            "code": 200,
                        }
                    )
                else:
                    self._send_json({"code": 404, "error": "not found"})

            def do_GET(self) -> None:
                if self.path == "/health":
                    fake.health_calls += 1
                    self._send_json(
                        {
                            "data": {"status": "ok", "service": "ace-step", "version": "1.5.0"},
                            "code": 200,
                        }
                    )
                elif self.path.startswith("/v1/audio"):
                    self.send_response(200)
                    self.send_header("Content-Type", "audio/wav")
                    self.send_header("Content-Length", str(len(fake.audio)))
                    self.end_headers()
                    self.wfile.write(fake.audio)
                else:
                    self._send_json({"code": 404, "error": "not found"})

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


def render_forward(payload: dict[str, Any]) -> bytes:
    """ACE's whole timeline: the preserved context plus regenerated tail, at -6 dB."""
    source = decode(Path(payload["src_audio_path"]).read_bytes())
    start = round(float(payload["repainting_start"]) * RATE)
    end = round(float(payload["repainting_end"]) * RATE)
    tail = sine((end - start) / RATE)
    out = np.concatenate([source.samples[:start], tail.samples]) * np.float32(0.5)
    return encode_wav(Audio(np.ascontiguousarray(out), RATE))


def render_backward(payload: dict[str, Any]) -> bytes:
    """The generated span followed by the preserved context, at -6 dB."""
    source = decode(Path(payload["src_audio_path"]).read_bytes())
    end = round(float(payload["repainting_end"]) * RATE)
    intro = sine(end / RATE)
    out = np.concatenate([intro.samples, source.samples[end:]]) * np.float32(0.5)
    return encode_wav(Audio(np.ascontiguousarray(out), RATE))


def request(
    *,
    bars: int = 4,
    overlap_bars: int = 2,
    direction: Direction = "forward",
    seed: int = 1234,
    context_seconds: float = 8.0,
) -> GenRequest:
    context = synthesize(120.0, (4, 4), key(), start_sec=0.0, duration_sec=context_seconds, seed=99)
    return GenRequest(
        capability="generate.extend",
        context=context,
        bpm=120.0,
        time_signature=(4, 4),
        key=key(),
        bars=bars,
        overlap_bars=overlap_bars,
        direction=direction,
        descriptors=("warm analog synths", "steady groove"),
        seed=seed,
        prompt="a long fade out",
    )


def backend(fake: FakeAceStep, config: AceStepConfig | None = None) -> AceStepBackend:
    return AceStepBackend(
        AceStepClient(fake.base_url, timeout_sec=5.0),
        config or AceStepConfig(poll_interval_sec=0.001),
    )


def test_forward_maps_to_a_repaint_after_the_context_and_undoes_the_gain() -> None:
    with FakeAceStep(render_forward) as fake:
        outputs = backend(fake).generate(request(), "preview", 1, lambda _pct: None)

    payload = fake.payloads[0]
    assert payload["task_type"] == "repaint"
    assert payload["repainting_start"] == 4.0
    assert payload["repainting_end"] == 16.0
    assert payload["inference_steps"] == 4
    assert payload["audio_format"] == "wav32"
    assert payload["bpm"] == 120
    assert payload["key_scale"] == "Am"
    assert payload["time_signature"] == "4"
    assert payload["seed"] == 1234
    assert "warm analog synths" in str(payload["prompt"])
    assert "a long fade out" in str(payload["prompt"])

    output = outputs[0]
    assert output.audio.duration_sec == pytest.approx(12.0, abs=0.001)  # 4 + 2 bars
    assert output.model == "ace-step"
    assert output.model_version == "1.5.0"
    assert output.seed == 1234
    # The returned file is at -6 dB; the preserved context measures the gain back.
    assert rms(output.audio) == pytest.approx(0.2 / np.sqrt(2.0), abs=0.005)


def test_hq_uses_the_configured_higher_step_count() -> None:
    with FakeAceStep(render_forward) as fake:
        backend(fake).generate(request(), "hq", 1, lambda _pct: None)
    assert fake.payloads[0]["inference_steps"] == 8


def test_n_candidates_use_distinct_seeds_and_progress() -> None:
    seen: list[float] = []
    with FakeAceStep(render_forward) as fake:
        outputs = backend(fake).generate(request(), "preview", 3, seen.append)

    assert [output.seed for output in outputs] == [1234, 1235, 1236]
    assert [payload["seed"] for payload in fake.payloads] == [1234, 1235, 1236]
    assert seen == [pytest.approx(1 / 3), pytest.approx(2 / 3), pytest.approx(1.0)]


def test_warmup_loads_the_model_through_init() -> None:
    with FakeAceStep(render_forward) as fake:
        backend(fake).warmup()

    assert fake.health_calls == 1
    assert fake.inits == [{"model": None, "init_llm": False}]


def test_backward_prepends_silence_and_repaints_the_intro() -> None:
    req = request(direction="backward", bars=4)
    sources: list[Audio] = []

    def render(payload: dict[str, Any]) -> bytes:
        sources.append(decode(Path(payload["src_audio_path"]).read_bytes()))
        return render_backward(payload)

    with FakeAceStep(render) as fake:
        outputs = backend(fake).generate(req, "preview", 1, lambda _pct: None)

    payload = fake.payloads[0]
    assert payload["repainting_start"] == 0.0
    assert payload["repainting_end"] == 12.0

    source = sources[0]
    assert source.duration_sec == pytest.approx(16.0, abs=0.001)  # 8 s new + 8 s context
    assert rms(source.trimmed(0, 8 * RATE)) < 0.001
    # The original context is appended unchanged after the silence.
    assert np.allclose(source.samples[8 * RATE :], req.context.samples)

    output = outputs[0]
    assert output.audio.duration_sec == pytest.approx(12.0, abs=0.001)
    assert rms(output.audio) == pytest.approx(0.2 / np.sqrt(2.0), abs=0.005)


def test_ace_key_spelling() -> None:
    assert ace_key(KeySpec.parse("A", "minor")) == "Am"
    assert ace_key(KeySpec.parse("C", "major")) == "C"
    assert ace_key(KeySpec.parse("F#", "minor")) == "F#m"


def test_caption_joins_descriptors_and_prompt() -> None:
    assert caption_for(request()) == "warm analog synths, steady groove, a long fade out"


def test_config_reads_the_checked_in_file(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("BRAGI_ACE_STEP_URL", raising=False)
    config = AceStepConfig.load()
    assert config.preview_steps == 4
    assert config.hq_steps == 8
    assert config.base_url == "http://127.0.0.1:8001"
    assert config.steps_for("preview") == 4
    assert config.steps_for("hq") == 8


def test_the_url_environment_variable_wins(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BRAGI_ACE_STEP_URL", "http://10.0.0.5:9001")
    assert AceStepConfig.load().base_url == "http://10.0.0.5:9001"


def render_fill(payload: dict[str, Any]) -> bytes:
    """ACE's middle-span repaint: a tone inside, the source preserved outside, at -6 dB."""
    source = decode(Path(payload["src_audio_path"]).read_bytes())
    start = round(float(payload["repainting_start"]) * RATE)
    end = round(float(payload["repainting_end"]) * RATE)
    middle = sine((end - start) / RATE).samples
    out = np.concatenate([source.samples[:start], middle, source.samples[end:]])
    return encode_wav(Audio(np.ascontiguousarray(out * np.float32(0.5)), RATE))


def fill_request(
    *, gap_bars: int = 2, lead_bars: float = 0.0, overlap_bars: int = 1
) -> FillRequest:
    return FillRequest(
        capability="generate.inpaint",
        before=synthesize(120.0, (4, 4), key(), start_sec=0.0, duration_sec=8.0, seed=99),
        after=synthesize(120.0, (4, 4), key(), start_sec=20.0, duration_sec=8.0, seed=100),
        bpm=120.0,
        time_signature=(4, 4),
        key=key(),
        gap_bars=gap_bars,
        lead_bars=lead_bars,
        overlap_bars=overlap_bars,
        descriptors=("warm analog synths",),
        seed=1234,
        prompt="fill it",
    )


def test_a_fill_repaints_the_middle_of_before_plus_gap_plus_after() -> None:
    req = fill_request(gap_bars=2, overlap_bars=1)
    sources: list[Audio] = []

    def render(payload: dict[str, Any]) -> bytes:
        sources.append(decode(Path(payload["src_audio_path"]).read_bytes()))
        return render_fill(payload)

    with FakeAceStep(render) as fake:
        outputs = backend(fake).generate_fill(req, "preview", 1, lambda _pct: None)

    payload = fake.payloads[0]
    # Source: 8 s before + 4 s gap + 8 s after; span: 2 s overlap + 4 s gap + 2 s.
    source = sources[0]
    assert source.duration_sec == pytest.approx(20.0, abs=0.001)
    assert payload["repainting_start"] == 6.0
    assert payload["repainting_end"] == 14.0
    assert payload["bpm"] == 120 and payload["key_scale"] == "Am"
    assert "fill it" in str(payload["prompt"])
    assert rms(source.trimmed(8 * RATE, 12 * RATE)) < 0.001

    output = outputs[0]
    assert output.audio.duration_sec == pytest.approx(8.0, abs=0.001)  # 2 + 4 + 2 s
    assert rms(output.audio) == pytest.approx(0.2 / np.sqrt(2.0), abs=0.005)


def test_a_transition_fill_centres_the_span_on_the_join() -> None:
    req = fill_request(gap_bars=0, lead_bars=1.0, overlap_bars=1)
    with FakeAceStep(render_fill) as fake:
        outputs = backend(fake).generate_fill(req, "preview", 1, lambda _pct: None)

    payload = fake.payloads[0]
    # 8 s before, join at 8 s: the span starts one bar (2 s) + one overlap before.
    assert payload["repainting_start"] == 4.0
    assert payload["repainting_end"] == 12.0
    assert outputs[0].audio.duration_sec == pytest.approx(8.0, abs=0.001)
