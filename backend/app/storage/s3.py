"""S3 adapter (SeaweedFS in FileGrid; any S3-compatible service with path-style addressing).

Write path: the input is re-sliced into parts of ``FILEGRID_S3_PART_SIZE`` (default 8 MiB). An object
smaller than one part is sent with a single ``PutObject``; anything larger uses a multipart upload with
one part in flight at a time, so memory stays around two part sizes whatever the object size. S3 makes
the object visible only on ``CompleteMultipartUpload``/``PutObject`` success (atomic replace). On any
error or cancellation the multipart upload is aborted, so no orphan parts are left behind.

Read path: ``GetObject`` streaming body, read in blocks of at most 1 MiB; the HTTP connection is closed
when the iterator is closed early.

Settings: see ``config.S3Settings`` (FILEGRID_S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET, ...).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import AsyncIterable, AsyncIterator

import aiohttp
from aiobotocore.config import AioConfig
from aiobotocore.session import get_session
from botocore.exceptions import BotoCoreError, ClientError

from .base import (
    HashingStream,
    HealthStatus,
    ObjectNotFound,
    PutResult,
    StorageAdapter,
    StorageError,
    StorageUnavailable,
    rechunk,
    validate_key,
)
from .config import S3Settings

__all__ = ["S3Storage"]

log = logging.getLogger("filegrid.storage.s3")

READ_BLOCK = 1024 * 1024
_NOT_FOUND = {"NoSuchKey", "404", "NotFound"}
_session = None


def _shared_session():
    """One botocore session per process: it caches the parsed S3 service model (~10 MiB of Python
    objects), which would otherwise be loaded again for every S3Storage instance."""
    global _session
    if _session is None:
        _session = get_session()
    return _session


def _translate(exc: BaseException, key: str | None = None) -> BaseException:
    """Map botocore/aiohttp errors to storage errors (messages carry no credentials)."""
    if isinstance(exc, StorageError):
        return exc
    if isinstance(exc, ClientError):
        err = exc.response.get("Error", {})
        code = str(err.get("Code", ""))
        status = int(exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode", 0) or 0)
        if code in _NOT_FOUND:
            return ObjectNotFound(f"s3: no object {key!r}")
        if status >= 500 or code in {"SlowDown", "ServiceUnavailable", "InternalError", "RequestTimeout"}:
            return StorageUnavailable(f"s3: {code or status}")
        return StorageError(f"s3: {code or status}")
    if isinstance(exc, (BotoCoreError, aiohttp.ClientError, OSError, asyncio.TimeoutError)):
        return StorageUnavailable(f"s3: {type(exc).__name__}")
    return exc


class S3Storage(StorageAdapter):
    name = "s3"

    def __init__(self, settings: S3Settings, *, name: str = "s3"):
        self.name = name
        self._settings = settings
        self._bucket = settings.bucket
        self._client = None
        self._stack: contextlib.AsyncExitStack | None = None
        self._lock = asyncio.Lock()

    async def _get_client(self):
        if self._client is None:
            async with self._lock:
                if self._client is None:
                    s = self._settings
                    config = AioConfig(
                        signature_version="s3v4",
                        s3={"addressing_style": "path"},
                        connect_timeout=s.connect_timeout,
                        read_timeout=s.read_timeout,
                        retries={"max_attempts": 2, "mode": "standard"},
                        max_pool_connections=s.max_pool,
                        # SeaweedFS does not need the newer default CRC trailers; keep requests plain.
                        request_checksum_calculation="when_required",
                        response_checksum_validation="when_required",
                    )
                    stack = contextlib.AsyncExitStack()
                    client = await stack.enter_async_context(
                        _shared_session().create_client(
                            "s3",
                            endpoint_url=s.endpoint,
                            region_name=s.region,
                            aws_access_key_id=s.access_key,
                            aws_secret_access_key=s.secret_key,
                            config=config,
                        )
                    )
                    self._stack, self._client = stack, client
        return self._client

    async def put_stream(self, key: str, chunks: AsyncIterable[bytes]) -> PutResult:
        validate_key(key)
        hashing = HashingStream(chunks)
        part_size = self._settings.part_size
        upload_id: str | None = None
        try:
            client = await self._get_client()
            parts: list[dict] = []
            async with contextlib.aclosing(rechunk(hashing, part_size)) as blocks:
                async for block in blocks:
                    if upload_id is None and len(block) < part_size:
                        # rechunk yields a short block only last: the whole object fits in one request
                        await client.put_object(Bucket=self._bucket, Key=key, Body=block)
                        return hashing.result()
                    if upload_id is None:
                        resp = await client.create_multipart_upload(Bucket=self._bucket, Key=key)
                        upload_id = resp["UploadId"]
                    number = len(parts) + 1
                    resp = await client.upload_part(
                        Bucket=self._bucket, Key=key, PartNumber=number, UploadId=upload_id, Body=block
                    )
                    parts.append({"ETag": resp["ETag"], "PartNumber": number})
                    del block
            if upload_id is None:  # empty input
                await client.put_object(Bucket=self._bucket, Key=key, Body=b"")
                return hashing.result()
            await client.complete_multipart_upload(
                Bucket=self._bucket, Key=key, UploadId=upload_id, MultipartUpload={"Parts": parts}
            )
            upload_id = None
            return hashing.result()
        except BaseException as exc:
            if upload_id is not None:
                await self._abort(key, upload_id)
            translated = _translate(exc, key)
            if translated is exc:
                raise
            raise translated from exc

    async def _abort(self, key: str, upload_id: str) -> None:
        try:
            async with asyncio.timeout(5):
                await self._client.abort_multipart_upload(Bucket=self._bucket, Key=key, UploadId=upload_id)
        except BaseException as exc:  # noqa: BLE001 - best effort; the original error is what matters
            log.warning("s3: abort of multipart upload for %r failed: %s", key, type(exc).__name__)
            if isinstance(exc, asyncio.CancelledError):
                raise

    def get_stream(self, key: str) -> AsyncIterator[bytes]:
        validate_key(key)
        return self._get(key)

    async def _get(self, key: str) -> AsyncIterator[bytes]:
        try:
            client = await self._get_client()
            resp = await client.get_object(Bucket=self._bucket, Key=key)
        except Exception as exc:
            raise _translate(exc, key) from exc
        body = resp["Body"]
        try:
            while True:
                try:
                    block = await body.read(READ_BLOCK)
                except Exception as exc:
                    raise _translate(exc, key) from exc
                if not block:
                    break
                yield block
        finally:
            body.close()

    async def delete(self, key: str) -> None:
        validate_key(key)
        try:
            client = await self._get_client()
            await client.delete_object(Bucket=self._bucket, Key=key)
        except Exception as exc:
            translated = _translate(exc, key)
            if isinstance(translated, ObjectNotFound):
                return
            raise translated from exc

    async def health(self) -> HealthStatus:
        start = time.perf_counter()
        try:
            client = await self._get_client()
            await client.head_bucket(Bucket=self._bucket)
        except Exception as exc:  # noqa: BLE001 - health never raises
            detail = str(_translate(exc)) if not isinstance(exc, StorageError) else str(exc)
            return HealthStatus(False, (time.perf_counter() - start) * 1000, detail)
        return HealthStatus(True, (time.perf_counter() - start) * 1000, f"bucket {self._bucket} reachable")

    async def aclose(self) -> None:
        stack, self._stack, self._client = self._stack, None, None
        if stack is not None:
            await stack.aclose()
