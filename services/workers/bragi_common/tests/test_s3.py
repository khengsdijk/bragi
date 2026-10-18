"""Content addressing (05 §6): the same rules as the API's ``src/ids.ts``."""

from __future__ import annotations

import hashlib

from bragi_common.hashes import asset_hash, hashes_match, is_asset_hash, key_for


def test_asset_hash_matches_python_hashing() -> None:
    data = b"hello bragi"
    assert asset_hash(data) == "sha256:" + hashlib.sha256(data).hexdigest()


def test_key_layout_is_sha256_aa_bb_full() -> None:
    content_hash = "sha256:" + "ab" * 32
    assert key_for(content_hash) == f"sha256/ab/ab/{'ab' * 32}"


def test_validation_and_matching() -> None:
    data = b"x"
    good = asset_hash(data)
    assert is_asset_hash(good) is True
    assert is_asset_hash("sha256:short") is False
    assert is_asset_hash("md5:" + "a" * 32) is False
    assert hashes_match(good, data) is True
    assert hashes_match(good, b"y") is False
