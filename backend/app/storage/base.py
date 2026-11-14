"""Storage adapter contract shared by every FileGrid storage (S3, FTP, DB).

Owner: P1. Consumers: P2 (upload/download API, policy engine). Change only after telling P2.

Contract (all methods are ``async``; FastAPI runs them on its event loop):

``await adapter.put_stream(key, chunks) -> PutResult``
    Consumes an ``AsyncIterable[bytes]`` and stores it under ``key``. Memory use is constant: each adapter
    keeps at most one bounded buffer (S3 part, DB row) and never the whole object. SHA-256 and size are
    computed while streaming. The write is atomic and durable: when the call returns the object is complete
    and visible; if it raises, nothing partial is visible under ``key`` (an older object under the same key
    stays intact). Writing an existing key replaces it. ``PutResult`` is a NamedTuple, so
    ``size, sha256 = await adapter.put_stream(...)`` works.

``adapter.get_stream(key) -> AsyncIterator[bytes]``
    Plain method returning an async iterator over the stored bytes in bounded chunks. Raises
    ``ObjectNotFound`` (on first iteration) when the key does not exist. Stopping early (``break``,
    ``aclose()``, task cancellation, client disconnect) releases the connection. Use
    ``contextlib.aclosing`` when you may stop early, so the release is immediate rather than at GC time.

``await adapter.delete(key) -> None``
    Idempotent: deleting a missing key is not an error.

``await adapter.health() -> HealthStatus``
    Never raises for storage problems; returns ``HealthStatus(ok=False, ...)`` instead.

Errors (all subclasses of ``StorageError``): ``StorageUnavailable`` (storage down, timeout, circuit open:
retry later or fall back to the policy's fallback storage), ``ObjectNotFound``, ``IntegrityError`` (hash
mismatch: the file is corrupted, mark it so), ``InvalidKey`` (a ``ValueError`` too).

Keys (``validate_key``): 1..512 chars, ``/``-separated segments, each segment ``[A-Za-z0-9_][A-Za-z0-9._-]*``
(so no leading ``/``, no ``//``, no trailing ``/``, no ``.``/``..`` segment, no hidden ``.name`` segment, no
segment starting with ``-``).
Example: ``fault_records/2026/11/14/3f2a9c.bin``.

Download integrity (P2): wrap the stream so the hash is recomputed while the client receives it::

    async with contextlib.aclosing(verify_stream(adapter.get_stream(key), file.sha256)) as stream:
        async for chunk in stream:
            ...  # send to the client; IntegrityError is raised after the last chunk on mismatch

The hash covers the bytes as stored (ciphertext for encrypted categories). Because a mismatch is only
known at the end, the HTTP layer must abort the response (not finish it cleanly) when IntegrityError
is raised, and mark the file as corrupted.

``HashingStream`` hashes any async byte stream on the fly (e.g. the plaintext before encryption).
"""

from __future__ import annotations

import abc
import hashlib
import re
from collections.abc import AsyncIterable, AsyncIterator
from typing import NamedTuple

__all__ = [
    "MAX_KEY_LENGTH",
    "HashingStream",
    "HealthStatus",
    "IntegrityError",
    "InvalidKey",
    "ObjectNotFound",
    "PutResult",
    "StorageAdapter",
    "StorageError",
    "StorageUnavailable",
    "aclose_quietly",
    "validate_key",
    "verify_stream",
]

MAX_KEY_LENGTH = 512
_SEGMENT_RE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9._-]*")


class StorageError(Exception):
    """Base class for every storage-layer error."""


class StorageUnavailable(StorageError):
    """The storage cannot serve the request now (down, timed out, or its circuit breaker is open)."""


class ObjectNotFound(StorageError):
    """No object is stored under the requested key."""


class IntegrityError(StorageError):
    """The bytes read back do not match the expected SHA-256 (corruption)."""


class InvalidKey(StorageError, ValueError):
    """The key is not a safe storage key (see ``validate_key``)."""


class PutResult(NamedTuple):
    size: int
    sha256: str  # lowercase hex


class HealthStatus(NamedTuple):
    ok: bool
    latency_ms: float
    detail: str


def validate_key(key: str) -> str:
    """Return ``key`` unchanged if it is a safe storage key, else raise ``InvalidKey``."""
    if not isinstance(key, str) or not key:
        raise InvalidKey("key must be a non-empty string")
    if len(key) > MAX_KEY_LENGTH:
        raise InvalidKey(f"key longer than {MAX_KEY_LENGTH} characters")
    for segment in key.split("/"):
        if not _SEGMENT_RE.fullmatch(segment):
            raise InvalidKey(f"unsafe key segment {segment!r}")
    return key


async def aclose_quietly(stream: object) -> None:
    """Close an async generator/iterator if it supports ``aclose()``; ignore errors from closing."""
    aclose = getattr(stream, "aclose", None)
    if aclose is not None:
        try:
            await aclose()
        except Exception:  # noqa: BLE001 - closing must never mask the original outcome
            pass


class HashingStream:
    """Async iterator that passes chunks through while computing size and SHA-256.

    ``hs = HashingStream(chunks); async for c in hs: ...; hs.size, hs.sha256``.
    The values are final once the iterator is exhausted. Closing it closes the source.
    """

    def __init__(self, source: AsyncIterable[bytes]):
        self._it = aiter(source)
        self._hash = hashlib.sha256()
        self.size = 0

    def __aiter__(self) -> HashingStream:
        return self

    async def __anext__(self) -> bytes:
        chunk = await anext(self._it)
        if chunk:
            self._hash.update(chunk)
            self.size += len(chunk)
        return chunk

    async def aclose(self) -> None:
        await aclose_quietly(self._it)

    @property
    def sha256(self) -> str:
        return self._hash.hexdigest()

    def result(self) -> PutResult:
        return PutResult(self.size, self.sha256)


async def rechunk(source: AsyncIterable[bytes], size: int) -> AsyncIterator[bytes]:
    """Re-slice an async byte stream into blocks of exactly ``size`` bytes (the last one may be shorter).

    Memory stays below ``size`` + one input chunk; every input byte is copied a constant number of times.
    Takes ownership of ``source`` (closed when this generator finishes or is closed early).
    """
    if size <= 0:
        raise ValueError("size must be positive")
    buf = bytearray()
    try:
        async for chunk in source:
            if not chunk:
                continue
            buf += chunk
            if len(buf) < size:
                continue
            full = len(buf) - len(buf) % size
            for off in range(0, full, size):
                with memoryview(buf) as view:
                    block = bytes(view[off : off + size])
                yield block
            del buf[:full]  # one memmove per input chunk, not per block
        if buf:
            yield bytes(buf)
    finally:
        await aclose_quietly(source)


async def verify_stream(stream: AsyncIterable[bytes], expected_sha256: str) -> AsyncIterator[bytes]:
    """Yield ``stream`` unchanged while re-hashing it; raise ``IntegrityError`` at the end on mismatch.

    Takes ownership of ``stream``: it is closed when this generator finishes or is closed early.
    """
    expected = expected_sha256.lower()
    hashing = HashingStream(stream)
    try:
        async for chunk in hashing:
            yield chunk
    finally:
        await hashing.aclose()
    if hashing.sha256 != expected:
        raise IntegrityError(
            f"sha256 mismatch: expected {expected}, got {hashing.sha256} ({hashing.size} bytes read)"
        )


class StorageAdapter(abc.ABC):
    """Interface implemented by ``S3Storage``, ``FtpStorage``, ``DbStorage`` and ``ResilientStorage``."""

    name: str

    @abc.abstractmethod
    async def put_stream(self, key: str, chunks: AsyncIterable[bytes]) -> PutResult:
        """Store ``chunks`` under ``key`` atomically; return ``(size, sha256)`` of the stored bytes."""

    @abc.abstractmethod
    def get_stream(self, key: str) -> AsyncIterator[bytes]:
        """Return an async iterator over the stored bytes (bounded chunks)."""

    @abc.abstractmethod
    async def delete(self, key: str) -> None:
        """Delete ``key``; a missing key is not an error."""

    @abc.abstractmethod
    async def health(self) -> HealthStatus:
        """Cheap round trip to the storage; never raises for storage problems."""

    async def aclose(self) -> None:  # noqa: B027 - optional hook, default no-op
        """Release pooled connections/clients. Safe to call more than once."""
