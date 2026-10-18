"""Content-addressed S3 IO (``specs/05`` §6, worker contract §4.3 steps 3 and 5).

Downloads verify the hash before the bytes are handed to a capability; uploads
compute it and refuse to store a mismatch, so the store stays trustworthy.

boto3 is synchronous, so every call runs in a thread and never blocks the event
loop that also feeds progress events.
"""

from __future__ import annotations

import asyncio
from typing import Any

import boto3

from bragi_common.config import Settings
from bragi_common.hashes import asset_hash, hashes_match, key_for


class HashMismatchError(Exception):
    """Downloaded or about-to-be-uploaded bytes do not match their address."""


class ObjectStore:
    """Reads and writes the content-addressed bucket."""

    def __init__(self, settings: Settings) -> None:
        """Creates the boto3 client from the settings."""
        self._bucket = settings.s3_bucket
        self._client: Any = boto3.client(
            "s3",
            endpoint_url=settings.s3_endpoint,
            region_name=settings.s3_region,
            aws_access_key_id=settings.s3_access_key_id,
            aws_secret_access_key=settings.s3_secret_access_key,
            config=_client_config(settings.s3_force_path_style),
        )

    async def head(self, content_hash: str) -> int | None:
        """The object's size in bytes, or ``None`` when it is not stored."""

        def _head() -> int | None:
            try:
                response = self._client.head_object(Bucket=self._bucket, Key=key_for(content_hash))
            except self._client.exceptions.ClientError:
                return None
            length = response.get("ContentLength")
            return int(length) if length is not None else 0

        return await asyncio.to_thread(_head)

    async def download(self, content_hash: str) -> bytes:
        """Downloads and verifies an object, raising on a hash mismatch."""

        def _get() -> bytes:
            response = self._client.get_object(Bucket=self._bucket, Key=key_for(content_hash))
            return bytes(response["Body"].read())

        data = await asyncio.to_thread(_get)
        if not hashes_match(content_hash, data):
            raise HashMismatchError(f"{content_hash} does not match its stored bytes")
        return data

    async def upload(self, data: bytes, mime: str | None = None) -> str:
        """Stores ``data`` under its content address and returns that address."""
        content_hash = asset_hash(data)

        def _put() -> None:
            extra = {} if mime is None else {"ContentType": mime}
            self._client.put_object(
                Bucket=self._bucket, Key=key_for(content_hash), Body=data, **extra
            )

        await asyncio.to_thread(_put)
        return content_hash

    async def upload_json(self, document: str) -> str:
        """Stores a JSON document as an ``application/json`` blob."""
        return await self.upload(document.encode("utf-8"), "application/json")


def _client_config(force_path_style: bool) -> Any:  # noqa: ANN401 - botocore's Config is untyped
    from botocore.config import Config

    return Config(s3={"addressing_style": "path" if force_path_style else "virtual"})
