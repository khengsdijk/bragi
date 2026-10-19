"""Domain failures a capability can raise (``specs/05`` §4.3, ``specs/04`` §10).

Any other exception is treated as a crash: retryable, code ``MODEL_ERROR``.
A :class:`JobFailure` says what went wrong and whether trying again can help, so a
corrupt upload is reported once instead of being retried three times.
"""

from __future__ import annotations


class JobFailure(Exception):  # noqa: N818 - reads as a noun at the call site: ``raise JobFailure(...)``
    """A failure with a stable error code and an explicit retry decision."""

    def __init__(self, code: str, message: str, *, retryable: bool = False) -> None:
        """Creates a failure.

        Args:
            code: A code from ``packages/schemas/api/errors.json``, e.g. ``ASSET_CORRUPT``.
            message: A user-facing reason (no audio content, lyrics or prompts).
            retryable: Whether a retry could succeed. Defaults to ``False``.
        """
        super().__init__(message)
        self.code = code
        self.retryable = retryable
