"""The Claude client seam for ``describe`` (ADR-0012).

``DescribeClient`` is the only thing the pipeline sees. ``AnthropicClient`` wraps the official
``anthropic`` SDK and is the production implementation. The SDK is imported lazily so that the rest
of the package imports without it. Tests inject a fake; the real API is only touched by a test that
is skipped unless ``ANTHROPIC_API_KEY`` is set.

The API key is read from the environment and is never logged, echoed in an error, or stored.
"""

from __future__ import annotations

import os
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from anthropic import AsyncAnthropic

#: The environment variable the SDK's default resolution also reads.
API_KEY_ENV = "ANTHROPIC_API_KEY"


class DescribeUnavailable(RuntimeError):
    """The describe stage cannot run here (no key, or the SDK is missing). A permanent error."""


class DescribeClient(Protocol):
    """One request/response exchange with the model. Returns the reply text."""

    async def complete(self, *, model: str, system: str, user: str, max_tokens: int) -> str:
        """Sends ``system`` and ``user`` to ``model`` and returns the concatenated text reply."""
        ...


class AnthropicClient:
    """``DescribeClient`` over the official ``anthropic`` SDK (``AsyncAnthropic``)."""

    def __init__(self, client: AsyncAnthropic) -> None:
        self._client = client

    @classmethod
    def from_env(cls) -> AnthropicClient:
        """Builds the client from ``ANTHROPIC_API_KEY``.

        Raises:
            DescribeUnavailable: when the key is unset or the ``anthropic`` package is missing.
        """
        if not os.environ.get(API_KEY_ENV):
            raise DescribeUnavailable(
                f"{API_KEY_ENV} is not set, so the description cannot be generated"
            )
        try:
            import anthropic
        except ImportError as exc:  # pragma: no cover - the package is a declared dependency
            raise DescribeUnavailable("the anthropic package is not installed") from exc
        # The SDK reads the key from the environment itself; nothing here holds it.
        return cls(anthropic.AsyncAnthropic(max_retries=2, timeout=120.0))

    async def complete(self, *, model: str, system: str, user: str, max_tokens: int) -> str:
        message = await self._client.messages.create(
            model=model,
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": user}],
        )
        return "".join(block.text for block in message.content if block.type == "text")


__all__ = ["API_KEY_ENV", "AnthropicClient", "DescribeClient", "DescribeUnavailable"]
