"""The OpenRouter client seam for ``describe`` (ADR-0012).

``DescribeClient`` is the only thing the pipeline sees. ``OpenRouterClient`` is the production
implementation: one chat-completions request to OpenRouter's OpenAI-compatible API. It uses the
standard library only (``urllib`` on a worker thread), and the transport is injectable so tests
exercise the request body, headers and error mapping without a network. The real API is only
touched by a test that is skipped unless ``OPENROUTER_API_KEY`` is set.

The API key is read from the environment and is never logged, echoed in an error, or stored beyond
the request headers.
"""

from __future__ import annotations

import asyncio
import json
import os
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol

from bragi_common.errors import JobFailure

#: The environment variable holding the OpenRouter key.
API_KEY_ENV = "OPENROUTER_API_KEY"
#: Optional override of the API base URL (a proxy or a test server).
BASE_URL_ENV = "OPENROUTER_BASE_URL"
#: ``allow`` or ``deny``: whether OpenRouter may route to providers that retain or train on prompts.
DATA_COLLECTION_ENV = "OPENROUTER_DATA_COLLECTION"

DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"
#: Recommended OpenRouter attribution headers.
APP_REFERER = "https://github.com/bragi-music/bragi"
APP_TITLE = "Bragi"
REQUEST_TIMEOUT_SEC = 120.0

#: The shape the model is asked to produce: the contract keys of ``DescriptionResult``
#: (``packages/schemas/analysis/description.schema.json``) minus the ``schemaVersion`` the worker
#: stamps itself. Sent non-strict because providers differ in what they enforce.
REPLY_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["summary", "sectionNotes", "whatMakesItWorks"],
    "properties": {
        "summary": {"type": "string", "minLength": 1},
        "sectionNotes": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["index", "text"],
                "properties": {
                    "index": {"type": "integer", "minimum": 0},
                    "text": {"type": "string", "minLength": 1},
                },
            },
        },
        "whatMakesItWorks": {"type": "array", "items": {"type": "string", "minLength": 1}},
    },
}

#: Response-format levels, tried from strongest to weakest when a model rejects one with a 400.
_FORMATS: tuple[str, ...] = ("json_schema", "json_object", "none")


class DescribeUnavailableError(RuntimeError):
    """The describe stage cannot run here (no key). A permanent error."""


class DescribeClient(Protocol):
    """One request/response exchange with the model. Returns the reply text."""

    async def complete(self, *, model: str, system: str, user: str, max_tokens: int) -> str:
        """Sends ``system`` and ``user`` to ``model`` and returns the text reply."""
        ...


@dataclass(frozen=True)
class HttpRequest:
    """What the client hands the transport."""

    url: str
    headers: dict[str, str]
    body: bytes
    timeout_sec: float


@dataclass(frozen=True)
class HttpResponse:
    """What the transport returns. Non-2xx statuses are returned, not raised."""

    status: int
    body: bytes


#: A blocking HTTP exchange. It raises ``TimeoutError`` or ``OSError`` on network failure.
Transport = Callable[[HttpRequest], HttpResponse]


def urllib_transport(request: HttpRequest) -> HttpResponse:
    """The production transport: ``urllib`` with HTTP errors returned as responses."""
    http_request = urllib.request.Request(  # noqa: S310 - the URL is https, from config
        request.url, data=request.body, headers=request.headers, method="POST"
    )
    try:
        with urllib.request.urlopen(http_request, timeout=request.timeout_sec) as response:  # noqa: S310
            return HttpResponse(response.status, response.read())
    except urllib.error.HTTPError as exc:
        return HttpResponse(exc.code, exc.read())
    except urllib.error.URLError as exc:
        # DNS failure, refused connection or a timeout wrapped by urllib: all transient.
        raise OSError(str(exc.reason)) from None


def _retryable(status: int) -> bool:
    return status in (408, 429) or status >= 500


def _error_message(status: int, body: bytes) -> str:
    """A short reason from OpenRouter's error body. Never includes the prompt or the key."""
    detail = ""
    try:
        data = json.loads(body)
        error = data.get("error") if isinstance(data, dict) else None
        if isinstance(error, dict) and isinstance(error.get("message"), str):
            detail = error["message"][:200]
    except ValueError:
        pass
    return f"OpenRouter returned HTTP {status}" + (f": {detail}" if detail else "")


class OpenRouterClient:
    """``DescribeClient`` over OpenRouter's chat-completions endpoint."""

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        data_collection: str = "deny",
        transport: Transport = urllib_transport,
    ) -> None:
        """Creates a client. ``transport`` is replaceable for tests."""
        self._api_key = api_key
        self._url = base_url.rstrip("/") + "/chat/completions"
        self._data_collection = data_collection
        self._transport = transport
        self._format_level = 0

    @classmethod
    def from_env(cls) -> OpenRouterClient:
        """Builds the client from ``OPENROUTER_API_KEY`` (and the optional overrides).

        Raises:
            DescribeUnavailableError: when the key is unset.
        """
        key = os.environ.get(API_KEY_ENV)
        if not key:
            raise DescribeUnavailableError(
                f"{API_KEY_ENV} is not set, so the description cannot be generated"
            )
        return cls(
            key,
            base_url=os.environ.get(BASE_URL_ENV) or DEFAULT_BASE_URL,
            data_collection=os.environ.get(DATA_COLLECTION_ENV) or "deny",
        )

    def _body(self, model: str, system: str, user: str, max_tokens: int) -> bytes:
        payload: dict[str, Any] = {
            "model": model,
            "max_tokens": max_tokens,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            # Only derived features are sent; still prefer providers that do not keep prompts.
            "provider": {"data_collection": self._data_collection},
        }
        match _FORMATS[self._format_level]:
            case "json_schema":
                payload["response_format"] = {
                    "type": "json_schema",
                    "json_schema": {
                        "name": "DescriptionResult",
                        "strict": False,
                        "schema": REPLY_SCHEMA,
                    },
                }
            case "json_object":
                payload["response_format"] = {"type": "json_object"}
        return json.dumps(payload).encode("utf-8")

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": APP_REFERER,
            "X-Title": APP_TITLE,
        }

    async def complete(self, *, model: str, system: str, user: str, max_tokens: int) -> str:
        """Sends one chat completion and returns the reply text.

        A model that rejects ``json_schema`` (HTTP 400) is retried at ``json_object``, then
        without a response format; the weaker level is remembered for later calls.

        Raises:
            JobFailure: ``MODEL_ERROR``; non-retryable for 400/401/403 and other 4xx, retryable
                for 408, 429, 5xx, timeouts, network errors and empty replies.
        """
        while True:
            request = HttpRequest(
                url=self._url,
                headers=self._headers(),
                body=self._body(model, system, user, max_tokens),
                timeout_sec=REQUEST_TIMEOUT_SEC,
            )
            try:
                response = await asyncio.to_thread(self._transport, request)
            except (TimeoutError, OSError) as exc:
                raise JobFailure(
                    "MODEL_ERROR", f"OpenRouter request failed: {exc}", retryable=True
                ) from None
            if response.status == 400 and self._format_level < len(_FORMATS) - 1:
                self._format_level += 1
                continue
            return self._text(response)

    @staticmethod
    def _text(response: HttpResponse) -> str:
        if not 200 <= response.status < 300:
            raise JobFailure(
                "MODEL_ERROR",
                _error_message(response.status, response.body),
                retryable=_retryable(response.status),
            )
        try:
            data = json.loads(response.body)
        except ValueError:
            raise JobFailure(
                "MODEL_ERROR", "OpenRouter returned a non-JSON body", retryable=True
            ) from None
        if isinstance(data, dict) and isinstance(data.get("error"), dict):
            # OpenRouter can report a provider failure inside a 200 body.
            code = data["error"].get("code")
            status = code if isinstance(code, int) else 502
            raise JobFailure(
                "MODEL_ERROR", _error_message(status, response.body), retryable=_retryable(status)
            )
        try:
            content = data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError):
            content = None
        if not isinstance(content, str) or not content.strip():
            raise JobFailure("MODEL_ERROR", "OpenRouter returned an empty reply", retryable=True)
        return content


__all__ = [
    "API_KEY_ENV",
    "BASE_URL_ENV",
    "DATA_COLLECTION_ENV",
    "DEFAULT_BASE_URL",
    "DescribeClient",
    "DescribeUnavailableError",
    "HttpRequest",
    "HttpResponse",
    "OpenRouterClient",
    "Transport",
]
