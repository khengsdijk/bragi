"""Content hashes and object keys (``specs/05`` §6).

The same rules as the API's ``src/ids.ts``: a content address is
``sha256:<lowercase hex>`` and its object key is
``sha256/<aa>/<bb>/<full-hex>``.
"""

from __future__ import annotations

import hashlib
import re

ASSET_HASH_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")


def hex_digest(data: bytes) -> str:
    """The lowercase hex SHA-256 of ``data``."""
    return hashlib.sha256(data).hexdigest()


def asset_hash(data: bytes) -> str:
    """The ``sha256:…`` content address of ``data``."""
    return f"sha256:{hex_digest(data)}"


def is_asset_hash(value: str) -> bool:
    """True when ``value`` is a well-formed content address."""
    return bool(ASSET_HASH_PATTERN.match(value))


def hashes_match(expected: str, data: bytes) -> bool:
    """True when ``data`` hashes to the content address ``expected``."""
    return is_asset_hash(expected) and asset_hash(data) == expected


def key_for(content_hash: str) -> str:
    """``sha256:<hex>`` → ``sha256/<aa>/<bb>/<hex>``."""
    hex_part = content_hash.split(":", 1)[-1]
    return f"sha256/{hex_part[:2]}/{hex_part[2:4]}/{hex_part}"
