"""PostgreSQL adapter: objects stored as ordered ``bytea`` rows in the schema ``blobstore``.

Schema (created by ``ensure_schema()``, idempotent, safe to run from many replicas at once)::

    blobstore.objects(key text PRIMARY KEY, size bigint, sha256 text, created_at timestamptz)
    blobstore.chunks(key text REFERENCES objects ON DELETE CASCADE, seq int, data bytea, PRIMARY KEY (key, seq))

``chunks.data`` uses ``STORAGE EXTERNAL`` (out-of-line, no compression attempt: payloads are often
already compressed or encrypted).

Write path: one transaction per object. It takes a per-key advisory lock (concurrent writers of the
same key serialize), deletes any previous version, inserts the object row, inserts the input re-sliced
into rows of ``FILEGRID_PG_CHUNK_SIZE`` (default 1 MiB) as it arrives, then records size and SHA-256 and
commits. Readers keep seeing the previous version until COMMIT (atomic replace); COMMIT is durable
(WAL fsync). Memory: one row buffer. Note: the transaction and a pool connection stay open while the
caller streams, so this storage suits small and medium objects (meter readings, documents) better
than slow multi-GiB uploads.

Read path: a REPEATABLE READ, read-only transaction with a server-side cursor that fetches two rows at a
time in ``seq`` order. The total length is checked against ``objects.size`` (a missing row raises
``IntegrityError``). Closing the iterator early rolls back and returns the connection to the pool.

Settings: see ``config.DbSettings`` (FILEGRID_PG_DSN, or POSTGRES_* with FILEGRID_PG_HOST/PORT).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import AsyncIterable, AsyncIterator

import asyncpg

from .base import (
    HashingStream,
    HealthStatus,
    IntegrityError,
    ObjectNotFound,
    PutResult,
    StorageAdapter,
    StorageError,
    StorageUnavailable,
    rechunk,
    validate_key,
)
from .config import DbSettings

__all__ = ["DbStorage", "SCHEMA"]

log = logging.getLogger("filegrid.storage.db")

SCHEMA = "blobstore"
_SCHEMA_LOCK_ID = 0x46470001  # advisory lock id for ensure_schema ("FG" 0001)
_KEY_LOCK_CLASS = 0x4647  # first half of the two-int advisory lock taken per key
# Waiting for a free pooled connection (all busy) is overload, not an outage: allow longer than a connect.
ACQUIRE_TIMEOUT_S = 10.0

_DDL = """
CREATE SCHEMA IF NOT EXISTS blobstore;
CREATE TABLE IF NOT EXISTS blobstore.objects (
    key        text PRIMARY KEY,
    size       bigint NOT NULL,
    sha256     text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS blobstore.chunks (
    key  text NOT NULL REFERENCES blobstore.objects (key) ON DELETE CASCADE,
    seq  integer NOT NULL,
    data bytea NOT NULL,
    PRIMARY KEY (key, seq)
);
"""


def _translate(exc: BaseException, key: str | None = None) -> BaseException:
    if isinstance(exc, StorageError):
        return exc
    if isinstance(
        exc,
        (
            OSError,
            asyncio.TimeoutError,
            asyncpg.PostgresConnectionError,
            asyncpg.CannotConnectNowError,
            asyncpg.InterfaceError,
            asyncpg.exceptions.AdminShutdownError,
            asyncpg.exceptions.InsufficientResourcesError,
            asyncpg.exceptions.TooManyConnectionsError,
        ),
    ):
        return StorageUnavailable(f"db: {type(exc).__name__}")
    if isinstance(exc, asyncpg.PostgresError):
        return StorageError(f"db: {type(exc).__name__}")
    return exc


class DbStorage(StorageAdapter):
    name = "db"

    def __init__(self, settings: DbSettings, *, name: str = "db"):
        self.name = name
        self._settings = settings
        self._pool: asyncpg.Pool | None = None
        self._lock = asyncio.Lock()
        self._schema_ready = False

    async def _get_pool(self) -> asyncpg.Pool:
        if self._pool is None or not self._schema_ready:
            async with self._lock:
                if self._pool is None:
                    s = self._settings
                    self._pool = await asyncpg.create_pool(
                        s.dsn,
                        min_size=0,
                        max_size=s.pool_max,
                        timeout=s.connect_timeout,
                        max_inactive_connection_lifetime=60.0,
                    )
                if not self._schema_ready:
                    await self._ensure_schema(self._pool)
        return self._pool

    async def ensure_schema(self) -> None:
        """Create the ``blobstore`` schema if needed (also done lazily on first use)."""
        try:
            await self._get_pool()
        except Exception as exc:
            raise _translate(exc) from exc

    async def _ensure_schema(self, pool: asyncpg.Pool) -> None:
        async with pool.acquire(timeout=ACQUIRE_TIMEOUT_S) as conn:
            async with conn.transaction():
                await conn.execute("SELECT pg_advisory_xact_lock($1)", _SCHEMA_LOCK_ID)
                await conn.execute(_DDL)
                storage = await conn.fetchval(
                    "SELECT attstorage FROM pg_attribute "
                    "WHERE attrelid = 'blobstore.chunks'::regclass AND attname = 'data'"
                )
                if storage != "e":
                    await conn.execute("ALTER TABLE blobstore.chunks ALTER COLUMN data SET STORAGE EXTERNAL")
        self._schema_ready = True

    async def put_stream(self, key: str, chunks: AsyncIterable[bytes]) -> PutResult:
        validate_key(key)
        hashing = HashingStream(chunks)
        try:
            pool = await self._get_pool()
            async with pool.acquire(timeout=ACQUIRE_TIMEOUT_S) as conn:
                async with conn.transaction():
                    await conn.execute(
                        "SELECT pg_advisory_xact_lock($1, hashtext($2))", _KEY_LOCK_CLASS, key
                    )
                    await conn.execute("DELETE FROM blobstore.objects WHERE key = $1", key)
                    await conn.execute(
                        "INSERT INTO blobstore.objects (key, size, sha256) VALUES ($1, 0, '')", key
                    )
                    insert = await conn.prepare(
                        "INSERT INTO blobstore.chunks (key, seq, data) VALUES ($1, $2, $3)"
                    )
                    seq = 0
                    async with contextlib.aclosing(rechunk(hashing, self._settings.chunk_size)) as blocks:
                        async for block in blocks:
                            await insert.fetch(key, seq, block)
                            seq += 1
                    await conn.execute(
                        "UPDATE blobstore.objects SET size = $2, sha256 = $3, created_at = now() WHERE key = $1",
                        key,
                        hashing.size,
                        hashing.sha256,
                    )
            return hashing.result()
        except BaseException as exc:
            await hashing.aclose()
            translated = _translate(exc, key)
            if translated is exc:
                raise
            raise translated from exc

    def get_stream(self, key: str) -> AsyncIterator[bytes]:
        validate_key(key)
        return self._get(key)

    async def _get(self, key: str) -> AsyncIterator[bytes]:
        try:
            pool = await self._get_pool()
            async with pool.acquire(timeout=ACQUIRE_TIMEOUT_S) as conn:
                async with conn.transaction(isolation="repeatable_read", readonly=True):
                    size = await conn.fetchval("SELECT size FROM blobstore.objects WHERE key = $1", key)
                    if size is None:
                        raise ObjectNotFound(f"db: no object {key!r}")
                    total = 0
                    async for record in conn.cursor(
                        "SELECT data FROM blobstore.chunks WHERE key = $1 ORDER BY seq", key, prefetch=2
                    ):
                        data = record[0]
                        total += len(data)
                        yield data
                    if total != size:
                        raise IntegrityError(f"db: object {key!r} has {total} bytes, expected {size}")
        except (StorageError, GeneratorExit, asyncio.CancelledError):
            raise
        except Exception as exc:
            raise _translate(exc, key) from exc

    async def delete(self, key: str) -> None:
        validate_key(key)
        try:
            pool = await self._get_pool()
            async with pool.acquire(timeout=ACQUIRE_TIMEOUT_S) as conn:
                await conn.execute("DELETE FROM blobstore.objects WHERE key = $1", key)
        except Exception as exc:
            raise _translate(exc, key) from exc

    async def health(self) -> HealthStatus:
        # A dedicated short-lived connection: a pool saturated by long uploads must not look "down".
        start = time.perf_counter()
        try:
            conn = await asyncpg.connect(self._settings.dsn, timeout=self._settings.connect_timeout)
            try:
                await conn.fetchval("SELECT 1")
            finally:
                await conn.close(timeout=1)
        except Exception as exc:  # noqa: BLE001 - health never raises
            return HealthStatus(False, (time.perf_counter() - start) * 1000, str(_translate(exc)))
        return HealthStatus(True, (time.perf_counter() - start) * 1000, "SELECT 1 ok")

    async def aclose(self) -> None:
        pool, self._pool = self._pool, None
        self._schema_ready = False
        if pool is not None:
            try:
                await asyncio.wait_for(pool.close(), 5)
            except Exception:  # noqa: BLE001
                pool.terminate()
