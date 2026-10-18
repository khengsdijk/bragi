"""Structured JSON logging (``specs/05`` §11).

One JSON object per line, so a container log is queryable. Audio content,
lyrics and prompts are never logged (13 §3) — nothing here can leak them, since
it is up to callers not to pass them in the first place.
"""

from __future__ import annotations

import json
import logging


class JsonFormatter(logging.Formatter):
    """Formats a record as one JSON object."""

    def format(self, record: logging.LogRecord) -> str:
        """Renders one record as a single JSON line."""
        payload: dict[str, object] = {
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
            "time": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
        }
        for key, value in getattr(record, "__dict__", {}).items():
            if key not in _RESERVED and not key.startswith("_"):
                payload[key] = value
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


_RESERVED = frozenset(
    {
        "name",
        "msg",
        "args",
        "levelname",
        "levelno",
        "pathname",
        "filename",
        "module",
        "exc_info",
        "exc_text",
        "stack_info",
        "lineno",
        "funcName",
        "created",
        "msecs",
        "relativeCreated",
        "thread",
        "threadName",
        "processName",
        "process",
        "taskName",
    }
)


def configure_logging(level: int = logging.INFO) -> None:
    """Installs the JSON formatter on the root logger, once."""
    root = logging.getLogger()
    root.setLevel(level)
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    root.handlers = [handler]
