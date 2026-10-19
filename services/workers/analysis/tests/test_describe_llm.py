"""The OpenRouter client: request body, headers and error mapping, over a fake transport."""

from __future__ import annotations

import asyncio
import json

import pytest

from bragi_analysis.describe.llm import (
    API_KEY_ENV,
    BASE_URL_ENV,
    DATA_COLLECTION_ENV,
    DescribeUnavailableError,
    HttpRequest,
    HttpResponse,
    OpenRouterClient,
)
from bragi_common.errors import JobFailure


def _ok(text: str = '{"summary": "x"}') -> HttpResponse:
    body = {"choices": [{"message": {"role": "assistant", "content": text}}]}
    return HttpResponse(200, json.dumps(body).encode())


class FakeTransport:
    """Returns canned responses (or raises them) and records each request."""

    def __init__(self, *responses: HttpResponse | Exception) -> None:
        self._responses = list(responses)
        self.requests: list[HttpRequest] = []

    def __call__(self, request: HttpRequest) -> HttpResponse:
        self.requests.append(request)
        item = self._responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    def body(self, index: int = 0) -> dict[str, object]:
        loaded = json.loads(self.requests[index].body)
        assert isinstance(loaded, dict)
        return loaded


def _complete(client: OpenRouterClient) -> str:
    return asyncio.run(client.complete(model="v/m", system="SYS", user="USR", max_tokens=77))


def test_request_body_and_headers() -> None:
    transport = FakeTransport(_ok("hello"))
    client = OpenRouterClient(
        "sk-test", base_url="https://example.test/api/v1/", transport=transport
    )

    assert _complete(client) == "hello"

    request = transport.requests[0]
    assert request.url == "https://example.test/api/v1/chat/completions"
    assert request.headers["Authorization"] == "Bearer sk-test"
    assert request.headers["X-Title"] == "Bragi"
    assert request.headers["HTTP-Referer"].startswith("https://")
    body = transport.body()
    assert body["model"] == "v/m"
    assert body["max_tokens"] == 77
    assert body["messages"] == [
        {"role": "system", "content": "SYS"},
        {"role": "user", "content": "USR"},
    ]
    assert body["provider"] == {"data_collection": "deny"}
    response_format = body["response_format"]
    assert isinstance(response_format, dict)
    assert response_format["type"] == "json_schema"
    assert response_format["json_schema"]["name"] == "DescriptionResult"


def test_a_model_that_rejects_json_schema_falls_back_and_remembers() -> None:
    transport = FakeTransport(HttpResponse(400, b"{}"), _ok(), _ok())
    client = OpenRouterClient("k", transport=transport)

    _complete(client)
    _complete(client)

    assert transport.body(1)["response_format"] == {"type": "json_object"}
    assert transport.body(2)["response_format"] == {"type": "json_object"}
    assert len(transport.requests) == 3


def test_fallback_ends_with_no_response_format_then_fails_non_retryably() -> None:
    transport = FakeTransport(
        HttpResponse(400, b"{}"), HttpResponse(400, b"{}"), HttpResponse(400, b"{}")
    )
    client = OpenRouterClient("k", transport=transport)

    with pytest.raises(JobFailure) as caught:
        _complete(client)

    assert "response_format" not in transport.body(2)
    assert caught.value.retryable is False
    assert caught.value.code == "MODEL_ERROR"


@pytest.mark.parametrize(
    ("status", "retryable"),
    [(401, False), (403, False), (404, False), (408, True), (429, True), (500, True), (503, True)],
)
def test_http_errors_map_to_retryability(status: int, retryable: bool) -> None:
    body = json.dumps({"error": {"message": "nope"}}).encode()
    client = OpenRouterClient("k", transport=FakeTransport(HttpResponse(status, body)))

    with pytest.raises(JobFailure, match=f"HTTP {status}: nope") as caught:
        _complete(client)

    assert caught.value.retryable is retryable


@pytest.mark.parametrize("error", [TimeoutError("timed out"), OSError("connection refused")])
def test_timeouts_and_network_errors_are_retryable(error: Exception) -> None:
    client = OpenRouterClient("k", transport=FakeTransport(error))

    with pytest.raises(JobFailure) as caught:
        _complete(client)

    assert caught.value.retryable is True


def test_an_error_inside_a_200_body_and_an_empty_reply_are_retryable() -> None:
    inside = HttpResponse(200, json.dumps({"error": {"code": 502, "message": "upstream"}}).encode())
    empty = HttpResponse(200, json.dumps({"choices": [{"message": {"content": ""}}]}).encode())
    for response in (inside, empty):
        client = OpenRouterClient("k", transport=FakeTransport(response))
        with pytest.raises(JobFailure) as caught:
            _complete(client)
        assert caught.value.retryable is True


def test_the_key_never_appears_in_an_error() -> None:
    client = OpenRouterClient("sk-secret", transport=FakeTransport(HttpResponse(401, b"{}")))

    with pytest.raises(JobFailure) as caught:
        _complete(client)

    assert "sk-secret" not in str(caught.value)


def test_from_env_reads_base_url_and_data_collection(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(API_KEY_ENV, "sk-env")
    monkeypatch.setenv(BASE_URL_ENV, "https://proxy.test/v1")
    monkeypatch.setenv(DATA_COLLECTION_ENV, "allow")
    transport = FakeTransport(_ok())
    client = OpenRouterClient.from_env()
    client._transport = transport

    _complete(client)

    assert transport.requests[0].url == "https://proxy.test/v1/chat/completions"
    assert transport.body()["provider"] == {"data_collection": "allow"}


def test_from_env_without_a_key_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(API_KEY_ENV, raising=False)

    with pytest.raises(DescribeUnavailableError, match=API_KEY_ENV):
        OpenRouterClient.from_env()
